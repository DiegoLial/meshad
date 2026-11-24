'use strict';

/**
 * meshad run --play: parser, tmux split, state-file writes, and the billing
 * rule (one unit per wait; an impression only for a NEW split carrying a signed
 * game ad). The wrapped child must keep running in every case.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startMockServer } = require('./helpers/mock-server');
const { parseRunArgs } = require('../src/commands/run');
const tmux = require('../src/play/tmux');
const bridge = require('../src/play/bridge');

const BIN = path.join(__dirname, '..', 'bin', 'meshad.js');

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function initialized(mockUrl, minWait = 2000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-runplay-'));
  const env = { MESHAD_CONFIG_DIR: dir, MESHAD_API_URL: mockUrl, MESHAD_LANG: 'en', NO_COLOR: '1', TMUX: '' };
  const r = await cli(['init', '--yes', '--email', 'play@test.dev'], env);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const cfgFile = path.join(dir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.min_wait_ms = minWait;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  return { dir, env };
}

/** A `tmux` on PATH that logs its argv and answers like the real one. */
function fakeTmux({ refuseSplit = false, windowActive = 1, paneActive = 0, attached = 1 } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-faketmux-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'tmux'), [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    'case "$1" in',
    '  -V) echo "tmux 3.4";;',
    `  split-window) ${refuseSplit ? 'exit 1' : 'echo %7'};;`,
    '  list-panes) echo %7;;',
    `  display-message) echo "%7 0 ${paneActive} ${windowActive} 0 ${attached}";;`,
    'esac',
  ].join('\n'), { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

const WAIT_SCRIPT = 'process.stdout.write("before\\n"); setTimeout(() => { process.stdout.write("after\\n"); process.exit(3); }, 6000);';
// Long enough for: 1.5s silence + 2s min wait, then ≥2s of continuous visibility.
const LONG_WAIT_SCRIPT = WAIT_SCRIPT.replace('6000', '9000');

/** Stand-in for `meshad play` in the split: beats play-render.json like the real one (pane %7). */
function fakePlayRender(dir, { pane = '%7' } = {}) {
  const t = setInterval(() => { try { bridge.writeRender(dir, Date.now(), pane); } catch { /* dir gone */ } }, 300);
  return () => clearInterval(t);
}

test('parser: --play before "--" is ours; everything after "--" is the child, verbatim', () => {
  assert.deepEqual(parseRunArgs(['--play', '--', 'claude']), { help: false, play: true, cmdline: ['claude'], error: null });
  assert.deepEqual(parseRunArgs(['--', 'claude']), { help: false, play: false, cmdline: ['claude'], error: null });
  // flags after "--" belong to the wrapped command — including --play and --help
  assert.deepEqual(parseRunArgs(['--', 'aider', '--help', '--play']).cmdline, ['aider', '--help', '--play']);
  assert.equal(parseRunArgs(['--', 'aider', '--help']).help, false);
  assert.equal(parseRunArgs(['--help']).help, true);
  // lenient legacy form (no separator) still works, with or without our flag
  assert.deepEqual(parseRunArgs(['claude', '-x']).cmdline, ['claude', '-x']);
  assert.deepEqual(parseRunArgs(['--play', 'claude']), { help: false, play: true, cmdline: ['claude'], error: null });
  // typos before "--" are loud, not silently ignored
  assert.equal(parseRunArgs(['--plya', '--', 'claude']).error, '--plya');
  assert.equal(parseRunArgs(['--play']).cmdline.length, 0);
});

test('tmux: command is quoted, carries config dir + lang; failures return null', () => {
  const cmd = tmux.playCommand({ dir: "/tmp/it's here", game: 'runner', adId: 'ad_x1', env: { MESHAD_LANG: 'pt-BR' }, node: '/usr/bin/node', bin: '/x/meshad.js' });
  assert.equal(cmd, "env 'MESHAD_CONFIG_DIR=/tmp/it'\\''s here' MESHAD_LANG=pt-BR /usr/bin/node /x/meshad.js play runner --ad ad_x1");
  assert.equal(tmux.playCommand({ dir: '/d', env: {}, node: 'n', bin: 'b' }), 'env MESHAD_CONFIG_DIR=/d n b play');
  assert.equal(tmux.available({ env: {} }), false, 'no $TMUX → unavailable');
  assert.equal(tmux.available({ env: { TMUX: '/tmp/x,1,0' }, run: () => ({ status: 0 }) }), true);
  assert.equal(tmux.available({ env: { TMUX: '/tmp/x,1,0' }, run: () => ({ status: 127 }) }), false);
  const calls = [];
  assert.equal(tmux.openSplit({ dir: '/d', game: 'runner', env: {}, run: (...a) => (calls.push(a), { status: 0, stdout: '%12\n' }) }), '%12');
  assert.ok(calls[0][1].includes('-d'), 'split is detached: focus stays on the agent');
  assert.equal(tmux.openSplit({ dir: '/d', env: {}, run: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(tmux.openSplit({ dir: '/d', env: {}, run: () => ({ status: 0, stdout: 'garbage' }) }), null);
  assert.equal(tmux.paneAlive('%7', { run: () => ({ status: 0, stdout: '%1\n%7\n' }) }), true);
  assert.equal(tmux.paneAlive('%7', { run: () => ({ status: 0, stdout: '%1\n' }) }), false);
});

test('e2e: run -- cmd --help hands --help to the child (it used to print meshad\'s own help)', async () => {
  const mock = await startMockServer();
  const { env } = await initialized(mock.url);
  const r = await cli(['run', '--', process.execPath, '--help'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Usage: node/, 'node\'s help ran');
  assert.doesNotMatch(r.stdout, /wrap any agent CLI/);
  await mock.close();
});

/** Run `--play` in a fake tmux; `render(dir, t)` decides what the fake game pane reports. */
async function playRun({ tmuxOpts, render }) {
  const mock = await startMockServer({ gameAd: 'runner' });
  const { dir, env } = await initialized(mock.url);
  const t = fakeTmux(tmuxOpts);
  const stop = render ? render(dir, t) : () => {};
  const r = await cli(['run', '--play', '--', process.execPath, '-e', LONG_WAIT_SCRIPT], {
    ...env, TMUX: '/tmp/fake,1,0', PATH: `${t.bin}${path.delimiter}${process.env.PATH}`,
  });
  stop();
  const impressions = mock.received.events.filter((e) => e.event === 'impression');
  const events = mock.received.events;
  await mock.close();
  return { r, t, dir, impressions, events };
}

test('e2e: run --play inside tmux opens ONE split with the game ad skin; render + active window ≥2s bills it; pane focus is NOT required', async () => {
  const { r, t, dir, impressions } = await playRun({ render: (d) => fakePlayRender(d) }); // fake tmux: pane_active=0
  assert.equal(r.code, 3, 'the wrapped command\'s exit code is preserved');
  assert.match(r.stdout, /before/);
  assert.match(r.stdout, /after/);
  assert.doesNotMatch(r.stderr, /not inside tmux/);

  const splits = t.calls().filter((l) => l.startsWith('split-window'));
  assert.equal(splits.length, 1, 'one unit per wait');
  assert.match(splits[0], /-d /, 'focus is not stolen from the agent');
  assert.match(splits[0], /play runner --ad ad_gamerunner/);
  assert.match(splits[0], new RegExp(`MESHAD_CONFIG_DIR=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  assert.equal(impressions.length, 1);
  assert.equal(impressions[0].ad_id, 'ad_gamerunner');
  assert.deepEqual(Object.keys(impressions[0]).filter((k) => ['ad_id', 'duration_ms', 'pane', 'visible', 'rendering'].includes(k)).sort(), ['ad_id', 'duration_ms'], 'no new telemetry field');
  assert.ok(impressions[0].duration_ms >= 2000, `visible duration ${impressions[0].duration_ms}`);
  assert.equal(fs.existsSync(path.join(dir, bridge.STATE_FILE)), false, 'state file removed on exit');
});

test('e2e: the split opens but play never reports rendering → nothing is billed', async () => {
  const { r, t, impressions } = await playRun({ render: null });
  assert.equal(r.code, 3);
  assert.equal(t.calls().filter((l) => l.startsWith('split-window')).length, 1);
  assert.equal(impressions.length, 0, 'opening the split alone is not an impression');
});

test('e2e: play renders but the tmux window is not the active one → nothing is billed', async () => {
  const { impressions } = await playRun({ tmuxOpts: { windowActive: 0 }, render: (d) => fakePlayRender(d) });
  assert.equal(impressions.length, 0);
});

test('e2e: play renders but no client is attached to the session → nothing is billed', async () => {
  const { impressions } = await playRun({ tmuxOpts: { attached: 0 }, render: (d) => fakePlayRender(d) });
  assert.equal(impressions.length, 0);
});

test('e2e: rendering that starts late is billed only for the visible part (duration < time since the split opened)', async () => {
  const { impressions } = await playRun({
    render: (d, t) => {
      let stop = () => {};
      const wait = setInterval(() => {
        if (t.calls().some((l) => l.startsWith('split-window'))) {
          clearInterval(wait);
          setTimeout(() => { stop = fakePlayRender(d); }, 2500);
        }
      }, 100);
      return () => { clearInterval(wait); stop(); };
    },
  });
  assert.equal(impressions.length, 1);
  // the split is open ≈5.5s (9s − 1.5s silence − 2s min wait); play only drew for the last ≈3s
  assert.ok(impressions[0].duration_ms >= 2000 && impressions[0].duration_ms < 4500, `duration ${impressions[0].duration_ms}`);
});

test('e2e: run --play outside tmux warns on stderr, still writes only waiting|idle, bills nothing', async () => {
  const mock = await startMockServer({ gameAd: 'runner' });
  const { dir, env } = await initialized(mock.url);
  const seen = new Set();
  const poll = setInterval(() => {
    const s = bridge.readState(dir);
    if (s) seen.add(s.state);
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, bridge.STATE_FILE), 'utf8'));
      assert.deepEqual(Object.keys(raw).sort(), ['state', 'ts']);
    } catch { /* between rename and read */ }
  }, 50);
  const r = await cli(['run', '--play', '--', process.execPath, '-e', WAIT_SCRIPT], env);
  clearInterval(poll);

  assert.equal(r.code, 3);
  assert.match(r.stdout, /after/);
  assert.match(r.stderr, /not inside tmux — open "meshad play" in another pane/);
  assert.deepEqual([...seen].sort(), ['idle', 'waiting'], 'the file only ever says waiting or idle, and both happened');
  assert.equal(mock.received.events.filter((e) => e.event === 'impression').length, 0, 'no split → no impression');
  assert.ok(mock.received.events.some((e) => e.event === 'idle_start'), 'idle telemetry is unchanged');
  await mock.close();
});

test('e2e: tmux refusing the split must not break the wrap and bills nothing', async () => {
  const mock = await startMockServer({ gameAd: 'runner' });
  const { env } = await initialized(mock.url);
  const t = fakeTmux({ refuseSplit: true });
  const r = await cli(['run', '--play', '--', process.execPath, '-e', WAIT_SCRIPT], {
    ...env, TMUX: '/tmp/fake,1,0', PATH: `${t.bin}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /after/);
  assert.equal(mock.received.events.filter((e) => e.event === 'impression').length, 0);
  await mock.close();
});

test('e2e: plain `run` (no --play) is unchanged — no state file, no tmux, footer path as before', async () => {
  const mock = await startMockServer();
  const { dir, env } = await initialized(mock.url);
  const t = fakeTmux();
  const r = await cli(['run', '--', process.execPath, '-e', WAIT_SCRIPT], {
    ...env, TMUX: '/tmp/fake,1,0', PATH: `${t.bin}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(r.code, 3);
  assert.equal(t.calls().length, 0, 'tmux is never touched without --play');
  assert.equal(fs.existsSync(path.join(dir, bridge.STATE_FILE)), false);
  await mock.close();
});

test('e2e: meshad play without a TTY fails clearly with exit 1; unknown game exits 2; --help is English', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-playcmd-'));
  const base = { MESHAD_CONFIG_DIR: dir, NO_COLOR: '1' };
  const noTty = await cli(['play', 'runner'], { ...base, MESHAD_LANG: 'en' });
  assert.equal(noTty.code, 1);
  assert.match(noTty.stderr, /needs an interactive terminal/);
  const pt = await cli(['play'], { ...base, MESHAD_LANG: 'pt-BR' });
  assert.equal(pt.code, 1);
  assert.match(pt.stderr, /precisa de um terminal interativo/);
  const bad = await cli(['play', 'doom'], { ...base, MESHAD_LANG: 'en' });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown game "doom"/);
  const help = await cli(['play', '--help'], { ...base, MESHAD_LANG: 'pt-BR' });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /a small game for while your agent thinks/);
  assert.equal(fs.existsSync(path.join(dir, bridge.STATE_FILE)), false);
});

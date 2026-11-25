'use strict';

/**
 * Easy-UX: TTY widgets (menu.js), first-run onboarding, the bare-`meshad` menu,
 * `meshad run` with play_mode: 'yes' (no --play), the `meshad play` picker and
 * en / pt-BR catalog parity. Widgets and onboarding are driven in-process with
 * PassThrough streams; the CLI itself runs under `script` when a TTY is needed.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFile, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { startMockServer } = require('./helpers/mock-server');
const { selectPrompt, multiSelectPrompt, textPrompt } = require('../src/menu');
const { maybeRunOnboarding } = require('../src/onboarding');
const { playMenu } = require('../src/commands/play');
const interests = require('../src/interests');
const config = require('../src/config');
const i18n = require('../src/i18n');
const bridge = require('../src/play/bridge');
const tmux = require('../src/play/tmux');
const { sanitizeAnsiLine } = require('../src/render');

const BIN = path.join(__dirname, '..', 'bin', 'meshad.js');
const HAS_SCRIPT = spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
const NO_SCRIPT = HAS_SCRIPT ? false : 'util-linux `script` not available';

// ── helpers ──────────────────────────────────────────────────────────────

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';
const SPACE = ' ';
const BACKSPACE = '\x7f';

const tick = () => new Promise((r) => setImmediate(r));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Fake terminal: TTY-flagged PassThroughs plus a transcript of everything drawn. */
function fakeIo({ columns } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = function setRawMode(v) { this.isRaw = v; return this; };
  const stdout = new PassThrough();
  stdout.isTTY = true;
  if (columns) stdout.columns = columns;
  let buf = '';
  stdout.on('data', (d) => { buf += d; });
  return { stdin, stdout, out: () => buf, plain: () => stripAnsi(buf) };
}

async function press(io, ...keys) {
  for (const k of keys) {
    await tick();
    io.stdin.write(k);
  }
  await tick();
}

function settled(promise) {
  const state = { done: false, value: undefined };
  promise.then((v) => { state.done = true; state.value = v; });
  return state;
}

function tmpDir(prefix = 'meshad-easyux-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Point config + language at a fresh dir for in-process tests. */
function useEnv(extra = {}) {
  const dir = tmpDir();
  process.env.MESHAD_CONFIG_DIR = dir;
  process.env.MESHAD_LANG = extra.lang || 'en';
  process.env.NO_COLOR = '1';
  if (extra.apiUrl) process.env.MESHAD_API_URL = extra.apiUrl;
  else delete process.env.MESHAD_API_URL;
  i18n.init(null);
  return dir;
}

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

/**
 * Run the CLI inside a pty (`script -qefc`) and answer prompts: each step waits
 * for `wait` to show up in the output (after the previous match) then types `send`.
 */
function driveTty(args, env, steps, { timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = [process.execPath, BIN, ...args].map(tmux.shq).join(' ');
    const p = spawn('script', ['-qefc', cmd, '/dev/null'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let consumed = 0;
    let i = 0;
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`timed out at step ${i} (${steps[i] && steps[i].wait}); output so far:\n${stripAnsi(out)}`));
    }, timeout);
    const pump = () => {
      while (i < steps.length) {
        const m = steps[i].wait.exec(stripAnsi(out.slice(consumed)));
        if (!m) return;
        // advance past the whole chunk seen so far: later steps wait for NEW output
        consumed = out.length;
        const { send } = steps[i];
        i++;
        if (send) p.stdin.write(send);
      }
    };
    p.stdout.on('data', (d) => { out += d; pump(); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: stripAnsi(out), stepsDone: i });
    });
  });
}

async function initialized(mockUrl, { minWait = 2000, lang = 'en' } = {}) {
  const dir = tmpDir('meshad-easyux-cli-');
  const env = { MESHAD_CONFIG_DIR: dir, MESHAD_API_URL: mockUrl, MESHAD_LANG: lang, NO_COLOR: '1', TMUX: '' };
  const r = await cli(['init', '--yes', '--email', 'easy@test.dev'], env);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const cfg = readConfig(dir);
  cfg.min_wait_ms = minWait;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  return { dir, env };
}

function patchConfig(dir, patch) {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }));
}

const readConfig = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

/** A `tmux` on PATH that logs argv and answers like the real one (pane %7). */
function fakeTmux({ windowActive = 1 } = {}) {
  const bin = tmpDir('meshad-easyux-tmux-');
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'tmux'), [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    'case "$1" in',
    '  -V) echo "tmux 3.4";;',
    '  split-window) echo %7;;',
    '  list-panes) echo %7;;',
    `  display-message) echo "%7 0 0 ${windowActive} 0 1";;`,
    'esac',
  ].join('\n'), { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

function fakePlayRender(dir, pane = '%7') {
  const t = setInterval(() => { try { bridge.writeRender(dir, Date.now(), pane); } catch { /* dir gone */ } }, 300);
  return () => clearInterval(t);
}

const WAIT_SCRIPT = 'process.stdout.write("before\\n"); setTimeout(() => { process.stdout.write("after\\n"); process.exit(3); }, 6000);';
const LONG_WAIT_SCRIPT = WAIT_SCRIPT.replace('6000', '9000');

// ── menu.js widgets ──────────────────────────────────────────────────────

const OPTS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Gamma' },
  { value: 'd', label: 'Delta', disabled: true },
];

test('selectPrompt: Up/Down skip disabled items (and wrap), Enter returns the value', async () => {
  useEnv();
  const io = fakeIo();
  const p = selectPrompt({ title: 'Pick', options: OPTS, ...io });
  await press(io, DOWN, ENTER); // a → (b skipped) → c
  assert.equal(await p, 'c');

  const io2 = fakeIo();
  const p2 = selectPrompt({ options: OPTS, ...io2 });
  await press(io2, UP, ENTER); // a ↑ wraps past disabled d → c
  assert.equal(await p2, 'c');

  const io3 = fakeIo();
  const p3 = selectPrompt({ options: OPTS, ...io3 });
  await press(io3, DOWN, UP, ENTER); // c ↑ skips b → a
  assert.equal(await p3, 'a');
});

test('selectPrompt: starts on the first enabled item, never lands on a disabled one, null with nothing selectable', async () => {
  useEnv();
  const io = fakeIo();
  const p = selectPrompt({ options: OPTS, initialIndex: 1, ...io }); // index 1 is disabled
  await press(io, ENTER);
  assert.equal(await p, 'c');
  assert.equal(await selectPrompt({ options: [{ value: 'x', label: 'x', disabled: true }], ...fakeIo() }), null);
});

test('selectPrompt: Esc and Ctrl-C cancel with null; raw mode and the cursor are restored', async () => {
  useEnv();
  for (const key of [ESC, '\x03']) {
    const io = fakeIo();
    const p = selectPrompt({ title: 'Pick', options: OPTS, ...io });
    assert.equal(io.stdin.isRaw, true, 'raw while the prompt is open');
    assert.ok(io.out().includes('\x1b[?25l'), 'cursor hidden while open');
    await press(io, key);
    assert.equal(await p, null);
    assert.equal(io.stdin.isRaw, false, 'raw mode restored');
    assert.ok(io.out().endsWith('\x1b[?25h') || io.out().includes('\x1b[?25h'), 'cursor shown again');
  }
});

test('selectPrompt: stdin closing resolves null instead of hanging', async () => {
  useEnv();
  const io = fakeIo();
  const p = selectPrompt({ options: OPTS, ...io });
  await tick();
  io.stdin.end();
  assert.equal(await p, null);
});

test('selectPrompt: draws the title, hints for disabled items, and redraws in place', async () => {
  useEnv();
  const io = fakeIo();
  const p = selectPrompt({ title: 'Play', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Soon', hint: 'coming soon', disabled: true }], ...io });
  await press(io, ESC);
  await p;
  const text = io.plain();
  assert.match(text, /Play/);
  assert.match(text, /Alpha/);
  assert.match(text, /Soon\s+coming soon/);
});

test('multiSelectPrompt: Space toggles, Enter returns the chosen values in option order', async () => {
  useEnv();
  const io = fakeIo();
  const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];
  const p = multiSelectPrompt({ title: 'Topics', options: opts, ...io });
  // toggle C first, then A: result still follows option order
  await press(io, DOWN, DOWN, SPACE, UP, UP, SPACE, ENTER);
  assert.deepEqual(await p, ['a', 'c']);

  const io2 = fakeIo();
  const p2 = multiSelectPrompt({ options: opts, ...io2 });
  await press(io2, SPACE, SPACE, DOWN, SPACE, ENTER); // A on/off, B on
  assert.deepEqual(await p2, ['b']);
});

test('multiSelectPrompt: preselected values, disabled items cannot be toggled, nothing chosen → []', async () => {
  useEnv();
  const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }];
  const io = fakeIo();
  const p = multiSelectPrompt({ options: opts, selected: ['c', 'b', 'zzz'], ...io });
  await press(io, ENTER);
  assert.deepEqual(await p, ['c'], 'disabled and unknown preselections are dropped');

  const io2 = fakeIo();
  const p2 = multiSelectPrompt({ options: opts, ...io2 });
  await press(io2, DOWN, SPACE, ENTER); // down skips disabled B → C
  assert.deepEqual(await p2, ['c']);

  const io3 = fakeIo();
  const p3 = multiSelectPrompt({ options: opts, ...io3 });
  await press(io3, ENTER);
  assert.deepEqual(await p3, []);
});

test('multiSelectPrompt: the [x] / [ ] markers follow the toggles; Esc cancels with null', async () => {
  useEnv();
  const io = fakeIo();
  const p = multiSelectPrompt({ options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], ...io });
  await press(io, SPACE);
  assert.match(io.plain(), /\[x\] Alpha/);
  assert.match(io.plain(), /\[ \] Beta/);
  await press(io, ESC);
  assert.equal(await p, null);
  assert.equal(io.stdin.isRaw, false);
});

test('textPrompt: typing, Backspace, Enter returns the text', async () => {
  useEnv();
  const io = fakeIo();
  const p = textPrompt({ title: 'Nick', placeholder: 'type here', ...io });
  assert.match(io.plain(), /type here/, 'placeholder is shown while empty');
  await press(io, 'a', 'b', 'x', BACKSPACE, 'c', ENTER);
  assert.equal(await p, 'abc');
  assert.equal(io.out().includes('\x1b[?25l'), false, 'text input keeps the cursor visible');
});

test('textPrompt: a chunk carrying several keys (paste) is handled in order', async () => {
  useEnv();
  const io = fakeIo();
  const p = textPrompt({ ...io });
  await press(io, 'hello\x7f\x7fp\r');
  assert.equal(await p, 'help');
});

test('textPrompt: invalid input is rejected inline and the prompt stays open; a valid retry submits', async () => {
  useEnv();
  const io = fakeIo();
  const validate = (v) => (/^[a-z]{3,}$/.test(v) ? null : 'too short or invalid');
  const p = textPrompt({ title: 'Nick', validate, ...io });
  const s = settled(p);
  await press(io, 'a', ENTER);
  assert.equal(s.done, false, 'rejected: still waiting');
  assert.match(io.plain(), /too short or invalid/);
  await press(io, 'b', 'c'); // typing clears the error and keeps the value
  await press(io, ENTER);
  assert.equal(await p, 'abc');
});

test('textPrompt: Esc and Ctrl-C cancel with null', async () => {
  useEnv();
  for (const key of [ESC, '\x03']) {
    const io = fakeIo();
    const p = textPrompt({ ...io });
    await press(io, 'x', key);
    assert.equal(await p, null);
    assert.equal(io.stdin.isRaw, false);
  }
});

test('widgets: every drawn line stays within columns-1 visible columns (narrow tmux pane)', async () => {
  useEnv();
  const cols = 24;
  const long = 'A very long option label that would wrap in a narrow split pane';
  const io = fakeIo({ columns: cols });
  const p = selectPrompt({
    title: 'A title that is far too long for this narrow pane',
    subtitle: 'and a subtitle that is just as long as the title above it',
    options: [{ value: 'a', label: long, hint: 'with a hint that also overflows' }, { value: 'b', label: long, disabled: true }],
    ...io,
  });
  await press(io, DOWN, UP);
  await press(io, ESC);
  await p;
  const lines = stripAnsi(io.out()).split(/[\r\n]+/).filter(Boolean);
  assert.ok(lines.length > 0);
  for (const l of lines) assert.ok([...l].length <= cols - 1, `line wider than ${cols - 1}: ${JSON.stringify(l)}`);
  // the redraw moves up exactly the number of rows drawn (no wrapped extras)
  const drawn = (io.out().match(/\x1b\[(\d+)A/) || [])[1];
  assert.ok(drawn, 'redraw issued a cursor-up');
});

test('widgets: SGR styling survives the width clamp and a reset is never cut off', () => {
  const styled = '\x1b[1mbold text that is long\x1b[0m';
  const { text, width } = sanitizeAnsiLine(styled, 8);
  assert.equal(width, 8);
  assert.ok(text.startsWith('\x1b[1m') && text.endsWith('\x1b[0m'));
  assert.equal(stripAnsi(text).length, 8);
});

// ── onboarding.js ────────────────────────────────────────────────────────

test('onboarding: non-TTY is a no-op (nothing written, nothing read)', async () => {
  const dir = useEnv();
  const cfg = { ...config.load() };
  const plain = new PassThrough(); // no isTTY
  const out = new PassThrough();
  assert.equal(await maybeRunOnboarding({ dir, cfg, stdin: plain, stdout: out }), false);
  const tty = fakeIo();
  tty.stdin.isTTY = false;
  assert.equal(await maybeRunOnboarding({ dir, cfg, stdin: tty.stdin, stdout: tty.stdout }), false);
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'interests.json')), false);
  assert.equal(tty.out(), '', 'nothing drawn');
});

test('onboarding: TTY runs once, saves play_mode and onboarding_done; a second call is a no-op', async () => {
  const dir = useEnv();
  const io = fakeIo();
  const p = maybeRunOnboarding({ dir, cfg: config.load(), ...io });
  await press(io, ENTER); // games: Yes (first option)
  await press(io, ENTER); // news: No (default)
  assert.equal(await p, true);

  const cfg = config.load();
  assert.equal(cfg.play_mode, 'yes');
  assert.equal(cfg.onboarding_done, true);
  assert.equal(fs.existsSync(path.join(dir, 'interests.json')), false, 'news=no writes no interests file');
  assert.match(io.plain(), /Welcome to MeshAd/);
  assert.match(io.plain(), /settings saved/);

  const again = fakeIo();
  assert.equal(await maybeRunOnboarding({ dir, cfg: config.load(), ...again }), false);
  assert.equal(again.out(), '', 'second call draws nothing');
  assert.equal(config.load().play_mode, 'yes');
});

test('onboarding: "No" and "Ask me later" are stored; Esc on the games question means ask_later', async () => {
  for (const [keys, expected] of [[[DOWN, ENTER], 'no'], [[DOWN, DOWN, ENTER], 'ask_later'], [[ESC], 'ask_later']]) {
    const dir = useEnv();
    const io = fakeIo();
    const p = maybeRunOnboarding({ dir, cfg: config.load(), ...io });
    await press(io, ...keys);
    await press(io, ENTER); // news: No
    assert.equal(await p, true);
    assert.equal(config.load().play_mode, expected);
    assert.equal(config.load().onboarding_done, true);
  }
});

test('onboarding: news=yes prints the full consent text BEFORE saving interests.json (0600) with the picked topics', async () => {
  const dir = useEnv();
  const io = fakeIo();
  const p = maybeRunOnboarding({ dir, cfg: config.load(), ...io });
  await press(io, ENTER); // games yes
  await press(io, UP, ENTER); // news: up from the default "No" → "Yes"
  // consent screen is up; nothing may be on disk yet
  assert.match(io.plain(), /Optional dev\/AI headlines, filtered only on your computer\./);
  assert.match(io.plain(), new RegExp(`stored ONLY on this computer, in ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/interests\\.json \\(0600\\)`));
  assert.match(io.plain(), /no anon_id, no interests sent/);
  assert.match(io.plain(), /Nothing reads your prompts, code, responses or stdin\./);
  assert.match(io.plain(), /Revoke anytime: meshad interests disable or meshad interests clear\./);
  assert.equal(fs.existsSync(path.join(dir, 'interests.json')), false, 'nothing saved before consent');
  await press(io, ENTER); // Accept & pick topics
  assert.equal(fs.existsSync(path.join(dir, 'interests.json')), false, 'nothing saved before topics are confirmed');
  // topics: pick the first and third taxonomy entries
  await press(io, SPACE, DOWN, DOWN, SPACE, ENTER);
  assert.equal(await p, true);

  const file = path.join(dir, 'interests.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(state.topics, [interests.TAXONOMY[0], interests.TAXONOMY[2]]);
  assert.equal(state.enabled, true);
  assert.ok(Date.parse(state.consented_at) > 0, 'consent timestamp recorded');
  assert.ok(io.plain().indexOf('Nothing reads your prompts') < io.plain().indexOf('Pick your topics'), 'consent shown before the topic picker');
});

test('onboarding: declining consent writes no interests.json', async () => {
  const dir = useEnv();
  const io = fakeIo();
  const p = maybeRunOnboarding({ dir, cfg: config.load(), ...io });
  await press(io, ENTER); // games yes
  await press(io, UP, ENTER); // news yes
  await press(io, DOWN, ENTER); // consent: Skip
  assert.equal(await p, true);
  assert.equal(fs.existsSync(path.join(dir, 'interests.json')), false);
  assert.equal(config.load().onboarding_done, true);
  assert.equal(config.load().play_mode, 'yes');

  // Esc at the consent prompt is also a decline
  const dir2 = useEnv();
  const io2 = fakeIo();
  const p2 = maybeRunOnboarding({ dir: dir2, cfg: config.load(), ...io2 });
  await press(io2, ENTER);
  await press(io2, UP, ENTER);
  await press(io2, ESC);
  assert.equal(await p2, true);
  assert.equal(fs.existsSync(path.join(dir2, 'interests.json')), false);
});

// ── bare `meshad` ────────────────────────────────────────────────────────

test('meshad (bare), no TTY: prints usage and exits 2', async () => {
  const dir = tmpDir();
  const r = await cli([], { MESHAD_CONFIG_DIR: dir, MESHAD_LANG: 'en', NO_COLOR: '1' });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Usage: meshad <command>/);
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false, 'nothing written');
});

test('meshad menu without a TTY exits 1 with a clear message', async () => {
  const r = await cli(['menu'], { MESHAD_CONFIG_DIR: tmpDir(), MESHAD_LANG: 'en', NO_COLOR: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs an interactive terminal/);
});

test('meshad (bare), TTY: runs onboarding, then opens the menu; Esc quits with 0', { skip: NO_SCRIPT }, async () => {
  const dir = tmpDir();
  const r = await driveTty([], { MESHAD_CONFIG_DIR: dir, MESHAD_LANG: 'en', NO_COLOR: '1', TERM: 'xterm' }, [
    { wait: /Play a tiny game while your agent thinks/, send: ENTER }, // Yes
    { wait: /Show dev\/AI news headlines/, send: ENTER }, // No
    { wait: /all set/, send: '' },
    { wait: /Play a game/, send: ESC }, // home menu is up
  ]);
  assert.equal(r.stepsDone, 4, r.out);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Welcome to MeshAd/);
  const cfg = readConfig(dir);
  assert.equal(cfg.play_mode, 'yes');
  assert.equal(cfg.onboarding_done, true);
});

test('meshad (bare), TTY, already onboarded: goes straight to the menu', { skip: NO_SCRIPT }, async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ onboarding_done: true, play_mode: 'no' }));
  const r = await driveTty([], { MESHAD_CONFIG_DIR: dir, MESHAD_LANG: 'en', NO_COLOR: '1', TERM: 'xterm' }, [
    { wait: /Play a game/, send: ESC },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Welcome to MeshAd/);
});

// ── meshad run with play_mode: 'yes' ─────────────────────────────────────

test('run: play_mode "yes" (no --play) inside tmux binds prefix+j, auto-opens a detached split, bills the game ad ≥2s with no new telemetry fields, unbinds on exit', async () => {
  const mock = await startMockServer({ gameAd: 'runner' });
  const { dir, env } = await initialized(mock.url);
  patchConfig(dir, { play_mode: 'yes', onboarding_done: true });
  const t = fakeTmux();
  const stop = fakePlayRender(dir);
  const r = await cli(['run', '--', process.execPath, '-e', LONG_WAIT_SCRIPT], {
    ...env, TMUX: '/tmp/fake,1,0', PATH: `${t.bin}${path.delimiter}${process.env.PATH}`,
  });
  stop();
  const impressions = mock.received.events.filter((e) => e.event === 'impression');
  await mock.close();

  assert.equal(r.code, 3, 'the wrapped command\'s exit code is preserved');
  assert.match(r.stdout, /before/);
  assert.match(r.stdout, /after/);
  assert.doesNotMatch(r.stderr, /not inside tmux/);

  const calls = t.calls();
  const bindAt = calls.findIndex((l) => /^bind-key -T prefix j /.test(l));
  const unbindAt = calls.findIndex((l) => /^unbind-key -T prefix j/.test(l));
  assert.ok(bindAt >= 0, `prefix+j bound: ${calls.join(' | ')}`);
  assert.ok(unbindAt > bindAt, 'prefix+j unbound after exit');
  assert.match(calls[bindAt], /open-or-focus/);
  assert.equal(calls.filter((l) => /^bind-key/.test(l)).length, 1, 'bound once');

  const splits = calls.filter((l) => l.startsWith('split-window') && /play runner/.test(l) && /--ad ad_gamerunner/.test(l));
  assert.equal(splits.length, 1, 'one auto-opened split for the wait');
  assert.match(splits[0], /-d /, 'detached: focus stays with the agent');

  assert.equal(impressions.length, 1);
  assert.equal(impressions[0].ad_id, 'ad_gamerunner');
  assert.ok(impressions[0].duration_ms >= 2000, `visible duration ${impressions[0].duration_ms}`);
  assert.deepEqual(Object.keys(impressions[0]).sort(), ['ad_id', 'anon_id', 'duration_ms', 'event', 'sdk_version', 'terminal_type', 'ts'], 'no new telemetry fields');
  assert.equal(fs.existsSync(path.join(dir, bridge.STATE_FILE)), false, 'state file removed on exit');
});

test('run: play_mode "yes" outside tmux falls back cleanly to the normal footer — exit code and stdout intact, tmux untouched', async () => {
  const mock = await startMockServer({ gameAd: 'runner' });
  const { dir, env } = await initialized(mock.url);
  patchConfig(dir, { play_mode: 'yes', onboarding_done: true });
  const t = fakeTmux();
  const r = await cli(['run', '--', process.execPath, '-e', WAIT_SCRIPT], {
    ...env, TMUX: '', PATH: `${t.bin}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(r.code, 3);
  assert.equal(r.stdout.replace(/\r/g, ''), 'before\nafter\n', 'child stdout forwarded untouched');
  assert.match(r.stderr, /games are on but you are not inside tmux/);
  assert.equal(t.calls().length, 0, 'tmux never invoked');
  // No split to bill: whatever was shown is the ordinary footer, one unit per wait at most.
  assert.ok(mock.received.events.filter((e) => e.event === 'impression').length <= 1);
  assert.equal(fs.existsSync(path.join(dir, bridge.STATE_FILE)), false);
  await mock.close();
});

test('run: play_mode "no" / "ask_later" / null never touch tmux', async () => {
  const mock = await startMockServer({ gameAd: 'runner' });
  for (const play_mode of ['no', 'ask_later', null]) {
    const { dir, env } = await initialized(mock.url);
    patchConfig(dir, { play_mode, onboarding_done: true });
    const t = fakeTmux();
    const r = await cli(['run', '--', process.execPath, '-e', 'process.stdout.write("hi\\n"); process.exit(4);'], {
      ...env, TMUX: '/tmp/fake,1,0', PATH: `${t.bin}${path.delimiter}${process.env.PATH}`,
    });
    assert.equal(r.code, 4);
    assert.equal(t.calls().length, 0, `play_mode=${play_mode}`);
  }
  await mock.close();
});

for (const [lang, welcome, playTitle, newsTitle, done] of [
  ['en', /Welcome to MeshAd/, /Play a tiny game while your agent thinks/, /Show dev\/AI news headlines/, /all set/],
  ['pt-BR', /Bem-vindo ao MeshAd/, /Jogar um joguinho enquanto seu agente pensa/, /Mostrar manchetes de dev\/IA/, /tudo pronto/],
]) {
  test(`run: first-run onboarding on a TTY (${lang}) asks before the child starts, then wraps it`, { skip: NO_SCRIPT }, async () => {
    const mock = await startMockServer();
    const { dir, env } = await initialized(mock.url, { lang });
    patchConfig(dir, { onboarding_done: false, play_mode: null });
    const r = await driveTty(['run', '--', process.execPath, '-e', 'console.log("child-ran"); process.exit(5)'], { ...env, TERM: 'xterm' }, [
      { wait: playTitle, send: DOWN + ENTER }, // games: No
      { wait: newsTitle, send: ENTER }, // news: No
      { wait: done, send: '' },
    ]);
    await mock.close();
    assert.equal(r.stepsDone, 3, r.out);
    assert.match(r.out, welcome);
    assert.equal(r.code, 5, 'the wrapped exit code is preserved');
    assert.ok(r.out.indexOf('child-ran') > r.out.search(done), 'the child starts only after onboarding');
    const cfg = readConfig(dir);
    assert.equal(cfg.play_mode, 'no');
    assert.equal(cfg.onboarding_done, true);
  });
}

test('run: first-run onboarding does not repeat once onboarding_done is set', { skip: NO_SCRIPT }, async () => {
  const mock = await startMockServer();
  const { dir, env } = await initialized(mock.url);
  patchConfig(dir, { onboarding_done: true, play_mode: 'no' });
  const r = await driveTty(['run', '--', process.execPath, '-e', 'console.log("child-ran")'], { ...env, TERM: 'xterm' }, []);
  await mock.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /child-ran/);
  assert.doesNotMatch(r.out, /Welcome to MeshAd/);
});

// ── meshad play picker ───────────────────────────────────────────────────

test('playMenu: lists every game in order; picking one runs it and returns to the menu on the same row; Back returns 0', async () => {
  const dir = useEnv();
  const io = fakeIo();
  const ran = [];
  const p = playMenu({ dir, flags: {}, runGame: async (game) => { ran.push(game); }, ...io });
  await press(io, DOWN); // runner → termo
  await press(io, ENTER); // run termo
  assert.deepEqual(ran, ['termo']);
  await press(io, UP, ENTER); // menu reopened on termo; up → runner
  assert.deepEqual(ran, ['termo', 'runner']);
  await press(io, DOWN, DOWN, ENTER); // runner → termo → snake
  await press(io, DOWN, ENTER); // flappy
  await press(io, DOWN, ENTER); // blocks
  await press(io, DOWN, ENTER); // slide
  await press(io, DOWN, ENTER); // chess
  assert.deepEqual(ran, ['termo', 'runner', 'snake', 'flappy', 'blocks', 'slide', 'chess']);
  const plain = io.plain();
  const at = (label) => plain.lastIndexOf(label);
  const order = ['Wait Runner', 'Termo Dev', 'Snake', 'Flappy Term', 'Meshad Blocks', 'Slide 2048', 'Daily Mate', 'Join leaderboard', 'Headlines', 'Back'].map(at);
  assert.ok(order.every((i) => i >= 0), `all entries listed: ${order}`);
  assert.deepEqual(order, [...order].sort((x, y) => x - y), 'picker order');
  assert.doesNotMatch(plain, /coming soon/, 'no greyed-out placeholders left');
  // Leave is greyed out without a handle: from the top, cycling Up lands on Back (not "Leave")
  await press(io, ...Array(7).fill(UP), ENTER); // chess → … → runner → (wrap) Back
  assert.equal(await p, 0);
});

test('playMenu: Esc returns 0', async () => {
  const dir = useEnv();
  const io = fakeIo();
  const p = playMenu({ dir, runGame: async () => { throw new Error('no game expected'); }, ...io });
  await press(io, ESC);
  assert.equal(await p, 0);
});

test('playMenu: Join leaderboard asks for a nickname with inline validation, then joins through the (mock) server', async () => {
  const mock = await startMockServer();
  const dir = useEnv({ apiUrl: mock.url });
  const io = fakeIo();
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    const p = playMenu({ dir, runGame: async () => {}, ...io });
    await press(io, ...Array(7).fill(DOWN), ENTER); // runner … chess → Join leaderboard
    const s = settled(p);
    await press(io, 'a', 'b', ENTER); // too short
    assert.match(io.plain(), /handle must be 3-16 characters/);
    assert.equal(fs.existsSync(path.join(dir, 'leaderboard.json')), false, 'nothing sent for an invalid handle');
    assert.equal(mock.received.games.length, 0);
    await press(io, 'c', 'd', ENTER); // "abcd"
    for (let i = 0; i < 50 && mock.received.games.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.done, false, 'back at the picker');

    assert.equal(mock.received.games.length, 1);
    assert.deepEqual(mock.received.games[0].body, { handle: 'abcd', opt_in: true });
    const lb = JSON.parse(fs.readFileSync(path.join(dir, 'leaderboard.json'), 'utf8'));
    assert.equal(lb.handle, 'abcd');
    assert.equal(fs.statSync(path.join(dir, 'leaderboard.json')).mode & 0o777, 0o600);
    assert.ok(logged.some((l) => /joined the leaderboard as "abcd"/.test(l)));
    assert.ok(logged.every((l) => !l.includes(lb.token)), 'the token is never printed');

    await press(io, ESC);
    assert.equal(await p, 0);
    assert.match(io.plain(), /Change leaderboard nickname\s+current: abcd/, 'picker now offers to change the nickname');
  } finally {
    console.log = origLog;
    await mock.close();
  }
});

test('playMenu: Esc in the nickname prompt joins nothing; a taken handle reports the error and keeps the menu open', async () => {
  const mock = await startMockServer();
  const dir = useEnv({ apiUrl: mock.url });
  const io = fakeIo();
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const p = playMenu({ dir, runGame: async () => {}, ...io });
    await press(io, ...Array(7).fill(DOWN), ENTER); // Join leaderboard
    await press(io, 'x', ESC); // cancel the nickname prompt
    assert.equal(mock.received.games.length, 0);
    await press(io, ENTER); // menu reopened on "Join": try again
    await press(io, ...'taken_one'.split(''), ENTER);
    for (let i = 0; i < 50 && mock.received.games.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(errs.some((e) => /already taken/.test(e)), errs.join('\n'));
    assert.equal(fs.existsSync(path.join(dir, 'leaderboard.json')), false);
    await press(io, ESC);
    assert.equal(await p, 0);
  } finally {
    console.error = origErr;
    await mock.close();
  }
});

test('playMenu: Leave leaderboard is enabled once joined, removes the handle (server too) and greys out again', async () => {
  const mock = await startMockServer();
  const dir = useEnv({ apiUrl: mock.url });
  fs.writeFileSync(path.join(dir, 'leaderboard.json'), JSON.stringify({ handle: 'abcd', token: `gh_${'T'.repeat(40)}` }), { mode: 0o600 });
  const io = fakeIo();
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    const p = playMenu({ dir, runGame: async () => {}, ...io });
    await press(io, ...Array(8).fill(DOWN), ENTER); // runner … chess → Change nickname → Leave
    for (let i = 0; i < 50 && !mock.received.games.some((g) => g.method === 'DELETE'); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    const del = mock.received.games.find((g) => g.method === 'DELETE');
    assert.ok(del, 'server asked to delete the handle');
    assert.equal(del.auth, `Bearer gh_${'T'.repeat(40)}`);
    assert.equal(fs.existsSync(path.join(dir, 'leaderboard.json')), false);
    assert.ok(logged.some((l) => /left the leaderboard/.test(l)));
    await press(io, ESC);
    assert.equal(await p, 0);
    assert.match(io.plain(), /Join leaderboard\s+public nickname/, 'after leaving, the picker offers Join again');
  } finally {
    console.log = origLog;
    await mock.close();
  }
});

test('playMenu: never loads the leaderboard module before a handle exists (opt-in boundary)', async () => {
  const dir = useEnv();
  const lbPath = require.resolve('../src/leaderboard');
  delete require.cache[lbPath];
  const io = fakeIo();
  const p = playMenu({ dir, runGame: async () => {}, ...io });
  await press(io, ESC);
  await p;
  assert.equal(require.cache[lbPath], undefined, 'leaderboard.js not loaded');
});

// ── i18n parity ──────────────────────────────────────────────────────────

test('i18n: en and pt-BR catalogs have identical key sets (no missing translations)', () => {
  const { CATALOGS } = require('../src/i18n');
  const en = Object.keys(CATALOGS.en).sort();
  const pt = Object.keys(CATALOGS['pt-BR']).sort();
  const missingInPt = en.filter((k) => !(k in CATALOGS['pt-BR']));
  const missingInEn = pt.filter((k) => !(k in CATALOGS.en));
  assert.deepEqual(missingInPt, [], `missing in pt-BR: ${missingInPt.join(', ')}`);
  assert.deepEqual(missingInEn, [], `missing in en: ${missingInEn.join(', ')}`);
  assert.deepEqual(en, pt);
});

test('i18n: every pt-BR string keeps the same {placeholders} as English and is non-empty', () => {
  const { CATALOGS } = require('../src/i18n');
  const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(CATALOGS.en)) {
    const pt = CATALOGS['pt-BR'][key];
    assert.equal(typeof pt, 'string', key);
    assert.ok(pt.trim().length > 0, `${key} is empty in pt-BR`);
    assert.deepEqual(vars(pt), vars(CATALOGS.en[key]), `placeholder mismatch in ${key}`);
  }
});

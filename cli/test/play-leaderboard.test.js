'use strict';

/**
 * Leaderboard client: join/leave/submit against the mock API, token hygiene,
 * and — crucially — that nothing is sent unless the player opted in. No TTY.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startMockServer } = require('./helpers/mock-server');
const lb = require('../src/leaderboard');
const runner = require('../src/play/runner');
const termo = require('../src/play/termo');
const { seedFor } = require('../src/play/rng');
const { PlaySession } = require('../src/play/session');

const BIN = path.join(__dirname, '..', 'bin', 'meshad.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-lb-'));

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** Drive a runner session with a bot until it dies; returns the session. */
function playRunner(dir) {
  const s = new PlaySession({ game: 'runner', dir, now: () => Date.UTC(2026, 10, 24, 12) });
  s.key(' ');
  while (!s.result && s.run.alive) {
    const near = s.run.obstacles.some((o) => o.x > runner.DINO_X && o.x <= runner.DINO_X + 7);
    if (near) s.key(' ');
    s.tick();
  }
  return s;
}

test('session records a replayable log: seed + jumps reproduce the exact score (also across pause and freeze)', () => {
  const dir = tmp();
  const s = new PlaySession({ game: 'runner', dir, now: () => Date.UTC(2026, 10, 24, 12) });
  s.key(' ');
  s.key('p'); s.key(' '); s.key('p'); // jump requests while paused are not inputs
  while (s.run.alive) {
    if (s.run.obstacles.some((o) => o.x > runner.DINO_X && o.x <= runner.DINO_X + 7)) s.key(' ');
    s.tick();
  }
  assert.ok(s.result, 'a finished run is scoreable');
  assert.deepEqual([s.result.game, s.result.date], ['runner', '2026-11-24']);
  assert.ok(s.result.log.length > 0);
  assert.equal(runner.simulate(seedFor('2026-11-24', 'runner'), s.result.log).score, s.result.score);
  const before = JSON.stringify(s.result);
  s.key(' '); s.tick();
  assert.equal(JSON.stringify(s.result), before, 'inputs after death change nothing');
});

test('session: a termo win yields a replayable result; a loss yields none', () => {
  const dir = tmp();
  const now = () => Date.UTC(2026, 10, 24, 12);
  const type = (s, w) => { for (const ch of w) s.key(ch); s.key('enter'); };
  const won = new PlaySession({ game: 'termo', dir, now });
  const answer = termo.dailyWord('2026-11-24');
  type(won, termo.WORDS.find((w) => w !== answer));
  type(won, answer);
  assert.deepEqual(won.result, { game: 'termo', date: '2026-11-24', score: 5, log: [termo.WORDS.find((w) => w !== answer), answer] });
  assert.equal(termo.score(termo.replay(won.result.date, won.result.log)), won.result.score);

  const lost = new PlaySession({ game: 'termo', dir, now });
  for (let i = 0; i < 6; i++) type(lost, termo.WORDS.find((w) => w !== answer));
  assert.equal(lost.result, null);
});

test('join stores the token 0600 in the config dir; leave deletes it and asks the server to delete the handle', async () => {
  const mock = await startMockServer();
  const dir = tmp();
  try {
    await lb.join('Neo_dev', { dir, apiUrl: mock.url });
    assert.deepEqual(mock.received.games[0].body, { handle: 'Neo_dev', opt_in: true });
    const file = path.join(dir, 'leaderboard.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(lb.load(dir), { handle: 'Neo_dev', token: `gh_${'M'.repeat(40)}` });
    assert.deepEqual(fs.readdirSync(dir), ['leaderboard.json']);

    const r = await lb.leave({ dir, apiUrl: mock.url });
    assert.deepEqual(r, { left: true, remoteDeleted: true });
    assert.equal(lb.load(dir), null);
    assert.equal(mock.received.games.at(-1).method, 'DELETE');
    assert.equal(mock.received.games.at(-1).auth, `Bearer gh_${'M'.repeat(40)}`);
    assert.deepEqual(await lb.leave({ dir, apiUrl: mock.url }), { left: false, remoteDeleted: false });
  } finally { await mock.close(); }
});

test('submit sends only game, date, score and the input log, with the handle token as bearer', async () => {
  const mock = await startMockServer();
  const dir = tmp();
  try {
    await lb.join('neo_dev', { dir, apiUrl: mock.url });
    const s = playRunner(dir);
    const res = await lb.submit(s.result, { dir, apiUrl: mock.url });
    assert.equal(res.accepted, true);
    const sent = mock.received.games.at(-1);
    assert.equal(sent.path, '/v1/games/scores');
    assert.deepEqual(Object.keys(sent.body).sort(), ['date', 'game', 'log', 'score']);
    assert.deepEqual(sent.body, { game: 'runner', date: '2026-11-24', score: s.result.score, log: s.result.log });
    assert.equal(sent.auth, `Bearer gh_${'M'.repeat(40)}`);
    assert.ok(!JSON.stringify(sent.body).includes('anon') && !JSON.stringify(sent.body).includes('mock'), 'no identifiers in the body');
  } finally { await mock.close(); }
});

test('submit does nothing when the player never joined: no request at all', async () => {
  const mock = await startMockServer();
  try {
    assert.equal(await lb.submit({ game: 'termo', date: '2026-11-24', score: 6, log: ['array'] }, { dir: tmp(), apiUrl: mock.url }), null);
    assert.equal(mock.received.games.length, 0);
  } finally { await mock.close(); }
});

test('CLI: --join-leaderboard / --leave-leaderboard work without a TTY, in en and pt-BR, and never print the token', async () => {
  const mock = await startMockServer();
  try {
    const dir = tmp();
    const env = { MESHAD_CONFIG_DIR: dir, MESHAD_API_URL: mock.url, MESHAD_LANG: 'en', NO_COLOR: '1' };
    const bad = await cli(['play', '--join-leaderboard', 'x'], env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /3-16 characters/);
    const taken = await cli(['play', '--join-leaderboard', 'taken_one'], env);
    assert.equal(taken.code, 1);
    assert.match(taken.stderr, /already taken/);
    assert.equal(lb.load(dir), null);

    const ok = await cli(['play', '--join-leaderboard', 'neo_dev'], env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /joined the leaderboard as "neo_dev"/);
    assert.ok(!(ok.stdout + ok.stderr).includes('gh_'), 'token not printed');
    assert.equal(lb.load(dir).handle, 'neo_dev');

    const pt = await cli(['play', '--leave-leaderboard'], { ...env, MESHAD_LANG: 'pt-BR' });
    assert.equal(pt.code, 0, pt.stderr);
    assert.match(pt.stdout, /saiu do placar/);
    assert.equal(lb.load(dir), null);
    const again = await cli(['play', '--leave-leaderboard'], env);
    assert.match(again.stdout, /not joined/);
  } finally { await mock.close(); }
});

test('CLI: plain `meshad play` without a TTY stays offline (no join → no request)', async () => {
  const mock = await startMockServer();
  try {
    const dir = tmp();
    const r = await cli(['play', 'runner'], { MESHAD_CONFIG_DIR: dir, MESHAD_API_URL: mock.url, MESHAD_LANG: 'en', NO_COLOR: '1' });
    assert.equal(r.code, 1);
    assert.equal(mock.received.games.length, 0);
    assert.equal(mock.received.events.length, 0);
  } finally { await mock.close(); }
});

test('server refusals surface a short reason, never the token', async () => {
  const mock = await startMockServer();
  const dir = tmp();
  try {
    await lb.join('neo_dev', { dir, apiUrl: mock.url });
    await assert.rejects(
      lb.submit({ game: 'runner', date: '2026-11-24', score: 999, log: [] }, { dir, apiUrl: mock.url }),
      (e) => e.status === 422 && !String(e.message + e.stack).includes('gh_'),
    );
  } finally { await mock.close(); }
});

test('post-game path: an enrolled player\'s finished game is sent and reported; failures never throw', async () => {
  const mock = await startMockServer();
  const dir = tmp();
  const playCmd = require('../src/commands/play');
  const out = [];
  const origLog = console.log, origErr = console.error;
  const capture = async (fn) => {
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => out.push(a.join(' '));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
  };
  const prevDir = process.env.MESHAD_CONFIG_DIR;
  process.env.MESHAD_CONFIG_DIR = dir;
  try {
    // not enrolled: silent and offline
    await capture(() => playCmd.submitResult({ game: 'termo', date: '2026-11-24', score: 6, log: ['array'] }, dir));
    assert.deepEqual(out, []);
    assert.equal(mock.received.games.length, 0);

    await lb.join('neo_dev', { dir, apiUrl: mock.url });
    const s = playRunner(dir);
    await capture(() => playCmd.submitResult(s.result, dir));
    assert.match(out.join('\n'), new RegExp(`leaderboard: ${s.result.score} recorded for mockhandle`));
    assert.equal(mock.received.games.at(-1).path, '/v1/games/scores');

    out.length = 0;
    await capture(() => playCmd.submitResult({ ...s.result, score: 999 }, dir));
    assert.match(out.join('\n'), /score not sent/);
    assert.ok(!out.join('\n').includes('gh_'), 'token never printed');
  } finally {
    if (prevDir === undefined) delete process.env.MESHAD_CONFIG_DIR; else process.env.MESHAD_CONFIG_DIR = prevDir;
    await mock.close();
  }
});

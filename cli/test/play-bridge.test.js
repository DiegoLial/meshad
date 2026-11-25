'use strict';

/**
 * run ⇄ play bridge: the state file carries only waiting|idle, writes are
 * atomic, and PlaySession pauses/resumes on top of it — no TTY needed.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../src/play/bridge');
const { PlaySession, parseKeys } = require('../src/play/session');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-bridge-'));

test('bridge: the file holds exactly {state, ts}, state is waiting|idle only', () => {
  const dir = tmp();
  bridge.writeState(dir, 'waiting', 1234);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, bridge.STATE_FILE), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['state', 'ts']);
  assert.deepEqual(raw, { state: 'waiting', ts: 1234 });
  bridge.writeState(dir, 'idle', 5678);
  assert.deepEqual(bridge.readState(dir), { state: 'idle', ts: 5678 });
  for (const bad of ['displaying', 'paused', '', null, undefined, 'WAITING']) {
    assert.throws(() => bridge.writeState(dir, bad), /invalid play state/);
  }
  assert.deepEqual(bridge.readState(dir), { state: 'idle', ts: 5678 }, 'a rejected write leaves the file alone');
});

test('bridge: writes are atomic — no tmp file left behind, reader never sees a torn file', () => {
  const dir = tmp();
  for (let i = 0; i < 200; i++) {
    bridge.writeState(dir, i % 2 ? 'idle' : 'waiting', i);
    const r = bridge.readState(dir);
    assert.ok(r && (r.state === 'idle' || r.state === 'waiting'));
  }
  assert.deepEqual(fs.readdirSync(dir), [bridge.STATE_FILE]);
});

test('bridge: garbage, out-of-contract and missing files all read as null (→ free-play)', () => {
  const dir = tmp();
  assert.equal(bridge.readState(dir), null);
  const f = path.join(dir, bridge.STATE_FILE);
  for (const content of ['not json', '{}', '{"state":"waiting"}', '{"state":"displaying","ts":1}', '{"state":"idle","ts":"x"}']) {
    fs.writeFileSync(f, content);
    assert.equal(bridge.readState(dir), null, content);
  }
  bridge.writeState(dir, 'idle', 1);
  bridge.clearState(dir);
  assert.equal(bridge.readState(dir), null);
  bridge.clearState(dir); // idempotent
});

test('bridge: modeOf — a stale waiting beat means the writer died → free-play; idle never goes stale', () => {
  const now = 100000;
  assert.equal(bridge.modeOf(null, now), 'free');
  assert.equal(bridge.modeOf({ state: 'waiting', ts: now - 1000 }, now), 'waiting');
  assert.equal(bridge.modeOf({ state: 'waiting', ts: now - bridge.STALE_MS - 1 }, now), 'free');
  assert.equal(bridge.modeOf({ state: 'idle', ts: now - 10 * 60 * 1000 }, now), 'idle');
  assert.equal(bridge.gateFor({ state: 'idle', ts: now }, now), 'frozen');
  assert.equal(bridge.gateFor({ state: 'idle', ts: now }, now, true), 'run');
  assert.equal(bridge.gateFor(null, now), 'run');
});

function runnerSession(dir, clock) {
  const s = new PlaySession({ game: 'runner', dir, now: () => clock.t });
  s.key(' '); // start
  return s;
}

test('session: the runner freezes on idle, resumes on waiting, and space keeps it going (free-play)', () => {
  const dir = tmp();
  const clock = { t: 1000 };
  const s = runnerSession(dir, clock);
  const ticks = (n) => { for (let i = 0; i < n; i++) s.tick(); return s.run.tick; };

  bridge.writeState(dir, 'waiting', clock.t); s.poll();
  assert.equal(s.gate, 'run');
  assert.equal(ticks(5), 5);

  bridge.writeState(dir, 'idle', clock.t); s.poll();
  assert.equal(s.gate, 'frozen');
  assert.equal(ticks(5), 5, 'no progress while the agent is answering');
  s.key(' '); // while frozen, space is "keep playing", not a jump
  assert.equal(s.override, true);
  assert.equal(s.gate, 'run');
  assert.equal(ticks(3), 8, 'free-play continues');

  // The override is per-idle-period: back to waiting then idle again freezes again.
  bridge.writeState(dir, 'waiting', clock.t); s.poll();
  assert.equal(s.override, false);
  bridge.writeState(dir, 'idle', clock.t); s.poll();
  assert.equal(s.gate, 'frozen');
  assert.equal(ticks(4), 8);
  bridge.writeState(dir, 'waiting', clock.t); s.poll();
  assert.equal(ticks(2), 10, 'resumes exactly where it stopped');
});

test('session: no state file at all = free-play; deleting the file mid-game unfreezes', () => {
  const dir = tmp();
  const clock = { t: 1 };
  const s = runnerSession(dir, clock);
  s.poll();
  assert.equal(s.mode, 'free');
  bridge.writeState(dir, 'idle', clock.t); s.poll();
  assert.equal(s.gate, 'frozen');
  bridge.clearState(dir); s.poll(); // `meshad run` exited
  assert.equal(s.gate, 'run');
});

test('session: p pauses the runner; paused ticks do nothing', () => {
  const dir = tmp();
  const s = runnerSession(dir, { t: 1 });
  s.tick(); s.tick();
  s.key('p');
  s.tick(); s.tick();
  assert.equal(s.run.tick, 2);
  s.key('p');
  s.tick();
  assert.equal(s.run.tick, 3);
});

test('session: termo takes letters only while running; frozen swallows them', () => {
  const dir = tmp();
  const s = new PlaySession({ game: 'termo', dir, now: () => 5 });
  for (const k of 'arr') s.key(k);
  assert.equal(s.buffer, 'arr');
  bridge.writeState(dir, 'idle', 5); s.poll();
  s.key('a');
  assert.equal(s.buffer, 'arr', 'a frozen game ignores typing');
  s.key(' ');
  s.key('a'); s.key('y');
  assert.equal(s.buffer, 'array');
  s.key('enter');
  assert.equal(s.tm.guesses[0], 'array');
});

test('session: finishing a game exposes the share string; esc/ctrl-c end the session', () => {
  const dir = tmp();
  const s = new PlaySession({ game: 'termo', dir, now: () => Date.UTC(2026, 10, 24) });
  for (const g of ['cargo']) { for (const k of g) s.key(k); s.key('enter'); }
  assert.match(s.shareText, /^Termo Dev 2026-11-24 1\/6\n🟩🟩🟩🟩🟩$/);
  assert.match(s.render(80, 24).join('\n'), /Termo Dev 2026-11-24 1\/6/);
  s.key('esc');
  assert.equal(s.done, true);
  const t = new PlaySession({ game: null, dir });
  t.key('ctrl-c');
  assert.equal(t.done, true);
});

test('keys: raw chunks normalize; arrows become up/down/left/right, other escape sequences are dropped', () => {
  assert.deepEqual(parseKeys(' '), [' ']);
  assert.deepEqual(parseKeys('Ab\r'), ['a', 'b', 'enter']);
  assert.deepEqual(parseKeys('\x1b'), ['esc']);
  assert.deepEqual(parseKeys('\x1b[A'), ['up']);
  assert.deepEqual(parseKeys('\x1b[B\x1b[C\x1b[D'), ['down', 'right', 'left'], 'several arrows in one chunk');
  assert.deepEqual(parseKeys('\x1bOA'), ['up'], 'application cursor mode');
  assert.deepEqual(parseKeys('\x1b[1;5C'), ['right'], 'with a modifier');
  assert.deepEqual(parseKeys('\x1b[3~'), [], 'Delete is not a game key');
  assert.deepEqual(parseKeys('\x1b[Ax'), ['up', 'x'], 'keys after a sequence are kept');
  assert.deepEqual(parseKeys('\x1bx'), [], 'Alt+key is dropped');
  assert.deepEqual(parseKeys('O-O=Q'), ['o', '-', 'o', '=', 'q']);
  assert.deepEqual(parseKeys('\x03'), ['ctrl-c']);
  assert.deepEqual(parseKeys('\x7f'), ['backspace']);
});

// `../leaderboard` is the one networked module play.js may load, lazily and only for
// the explicit --join/--leave-leaderboard flags or an enrolled player's finished game
// (test/play-leaderboard.test.js proves no request is made otherwise).
test('play never reaches the network or telemetry: nothing it requires can send', () => {
  const files = [
    ...fs.readdirSync(path.join(__dirname, '..', 'src', 'play')).map((f) => path.join(__dirname, '..', 'src', 'play', f)),
    path.join(__dirname, '..', 'src', 'commands', 'play.js'),
  ];
  const forbidden = /^(\.\.?\/)+(net|telemetry|api|session)$|^node:(https?|net|tls|dgram)$/;
  for (const f of files) {
    const reqs = [...fs.readFileSync(f, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const r of reqs) {
      // ./session is play's own module; ../session (the telemetry-event glue) is not allowed.
      const bad = forbidden.test(r) && !(r === './session' && f.includes(`${path.sep}play${path.sep}`));
      assert.ok(!bad, `${path.basename(f)} requires ${r}`);
    }
  }
});

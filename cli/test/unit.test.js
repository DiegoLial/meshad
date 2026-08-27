'use strict';

/** Unit tests: idle FSM, renderer fail-closed behaviour, telemetry, ad cache. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const { IdleStateMachine } = require('../src/fsm');
const { LineRenderer, formatAd } = require('../src/render');
const { Telemetry, LAST_BATCH_FILE } = require('../src/telemetry');
const { AdCache } = require('../src/adcache');
const { startMockServer } = require('./helpers/mock-server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-cli-test-'));

const EV = (over = {}) => ({
  event: 'idle_start',
  ts: new Date().toISOString(),
  anon_id: ' '.trim() + '9f0c1b2a-3d4e-4f5a-8b6c-7d8e9f0a1b2c',
  terminal_type: 'claude-code',
  sdk_version: '0.1.0',
  ...over,
});

// ── FSM ───────────────────────────────────────────────────────────────
test('FSM: short wait never displays', () => {
  const fsm = new IdleStateMachine({ minWaitMs: 8000 });
  fsm.idleStart(0);
  assert.deepEqual(fsm.tick(7999), []);
  const actions = fsm.idleEnd(7999);
  assert.deepEqual(actions, [{ type: 'idle_end', duration_ms: 7999 }]);
});

test('FSM: long wait displays after threshold; impression only if ≥2s on screen', () => {
  const fsm = new IdleStateMachine({ minWaitMs: 8000 });
  fsm.idleStart(0);
  assert.deepEqual(fsm.tick(8000), [{ type: 'display' }]);

  // idle_end 1.5s after display → clear but NO impression
  const actions = fsm.idleEnd(9500);
  assert.deepEqual(actions.map((a) => a.type), ['clear', 'idle_end']);

  // again, this time displayed for 3s → clear + impression + idle_end
  fsm.idleStart(20000);
  fsm.tick(28000);
  const a2 = fsm.idleEnd(31000);
  assert.deepEqual(a2.map((a) => a.type), ['clear', 'impression', 'idle_end']);
  assert.equal(a2[1].displayed_ms, 3000);
  assert.equal(a2[2].duration_ms, 11000);
});

test('FSM: idle_end has absolute priority from any state', () => {
  const fsm = new IdleStateMachine({ minWaitMs: 8000 });
  assert.deepEqual(fsm.idleEnd(100), []); // from idle: nothing
  fsm.idleStart(0);
  const a = fsm.idleEnd(500); // from waiting: idle_end only, no clear needed
  assert.deepEqual(a, [{ type: 'idle_end', duration_ms: 500 }]);
  assert.equal(fsm.state, 'idle');
});

test('FSM: frequency cap respected within the sliding window', () => {
  const fsm = new IdleStateMachine({ minWaitMs: 1000, capPerHour: 2 });
  let now = 0;
  for (let i = 0; i < 2; i++) {
    fsm.idleStart(now);
    assert.equal(fsm.tick(now + 1000).length, 1, `display #${i + 1}`);
    fsm.idleEnd(now + 4000); // 3s displayed → impression recorded
    now += 10000;
  }
  // third wait inside the hour: cap reached → never displays
  fsm.idleStart(now);
  assert.deepEqual(fsm.tick(now + 1000), []);
  fsm.idleEnd(now + 5000);
  // one hour later the window slides and display works again
  now += 3600001;
  fsm.idleStart(now);
  assert.equal(fsm.tick(now + 1000).length, 1);
});

// ── renderer ──────────────────────────────────────────────────────────
test('renderer: no-op without a TTY (fail-closed)', () => {
  const writes = [];
  const fake = new Writable({
    write(chunk, _enc, cb) {
      writes.push(chunk.toString());
      cb();
    },
  });
  fake.isTTY = false;
  const r = new LineRenderer(fake);
  assert.equal(r.render('hello'), false);
  r.clear();
  assert.equal(writes.length, 0, 'nothing was written');
});

test('renderer: renders one dim footer line on a TTY and clears it', () => {
  const writes = [];
  const fake = new Writable({
    write(chunk, _enc, cb) {
      writes.push(chunk.toString());
      cb();
    },
  });
  fake.isTTY = true;
  fake.columns = 100;
  fake.rows = 30;
  const r = new LineRenderer(fake);
  assert.equal(r.render(formatAd({ format: 'text_line', render: { text: '▲ Tool', lines: ['▲ Tool'], cta: 'mesh.io/x', color: 'dim' } })), true);
  assert.ok(writes[0].includes('\x1b7') && writes[0].includes('\x1b8'), 'save/restore cursor');
  assert.ok(writes[0].includes('sponsored'), 'label always present');
  r.clear();
  assert.ok(writes[1].includes('\x1b[2K'), 'line erased');
});

// ── telemetry ─────────────────────────────────────────────────────────
test('telemetry: an event outside the contract throws locally (client bug)', () => {
  const t = new Telemetry({ dir: tmp(), apiUrl: 'http://unused' });
  assert.throws(() => t.enqueue(EV({ prompt: 'secret' })), /schema violation/);
  assert.throws(() => t.enqueue(EV({ event: 'impression' })), /schema violation/); // no ad_id
  assert.equal(t.pending, 0);
});

test('telemetry: valid batch is delivered and last-batch.json records exact bytes', async () => {
  const mock = await startMockServer();
  const dir = tmp();
  const t = new Telemetry({ dir, apiUrl: mock.url });
  t.enqueue(EV());
  t.enqueue(EV({ event: 'idle_end', duration_ms: 9000 }));
  const { sent, remaining } = await t.flush();
  assert.equal(sent, 2);
  assert.equal(remaining, 0);
  assert.equal(mock.received.events.length, 2);

  const last = JSON.parse(fs.readFileSync(path.join(dir, LAST_BATCH_FILE), 'utf8'));
  assert.equal(last.status, 202);
  assert.ok(last.body.includes('"idle_end"'), 'exact wire bytes stored for --explain');
  await mock.close();
});

test('telemetry: network failure keeps events buffered; next flush delivers', async () => {
  const dir = tmp();
  const dead = new Telemetry({ dir, apiUrl: 'http://127.0.0.1:1', maxAttempts: 1, backoffBaseMs: 1, timeoutMs: 200 });
  dead.enqueue(EV());
  const r1 = await dead.flush();
  assert.equal(r1.sent, 0);
  assert.equal(r1.remaining, 1, 'event survived the outage');

  const mock = await startMockServer();
  const alive = new Telemetry({ dir, apiUrl: mock.url }); // same dir → same persisted queue
  const r2 = await alive.flush();
  assert.equal(r2.sent, 1);
  assert.equal(mock.received.events.length, 1);
  await mock.close();
});

// ── ad cache ──────────────────────────────────────────────────────────
test('adcache: valid signatures accepted, cache reused while fresh', async () => {
  const mock = await startMockServer();
  const dir = tmp();
  let t = 1_000_000;
  const cache = new AdCache({ dir, apiUrl: mock.url, now: () => t });
  const ads = await cache.getAds({ anonId: 'x', terminalType: 'other' });
  assert.equal(ads.length, 2, 'both signed ads pass verification');

  await mock.close(); // server gone — fresh cache must still serve
  const again = await cache.getAds({ anonId: 'x', terminalType: 'other' });
  assert.equal(again.length, 2, 'served from cache with no network');

  t += 901 * 1000; // TTL (900s) expired, still no server → stale cache, never throws
  const stale = await cache.getAds({ anonId: 'x', terminalType: 'other' });
  assert.equal(stale.length, 2, 'stale cache served on network failure (fail-closed)');
});

test('adcache: tampered signatures are dropped silently and counted', async () => {
  const mock = await startMockServer({ tamperSignatures: true });
  const dir = tmp();
  const cache = new AdCache({ dir, apiUrl: mock.url });
  const ads = await cache.getAds({ anonId: 'x', terminalType: 'other' });
  assert.equal(ads.length, 0, 'no unsigned/forged ad is ever rendered');
  assert.equal(cache.peek().invalid_dropped_total, 2, 'drops surfaced for status');
  await mock.close();
});

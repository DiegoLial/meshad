'use strict';

/**
 * The impression gate for `run --play`: pure (tmux answer, render signal and clock
 * are injected). Billing needs play drawing AND the split's window active in an
 * attached session, continuously for ≥2s. Pane focus is never required.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../src/play/bridge');
const tmux = require('../src/play/tmux');
const { isVisible, VisibilityTracker } = require('../src/play/visibility');
const { IdleStateMachine } = require('../src/fsm');

const PANE = '%7';
const NOW = 1_000_000;
const render = (over = {}) => ({ rendering: true, ts: NOW - 200, pane: PANE, ...over });
const info = (over = {}) => ({ dead: false, paneActive: false, windowActive: true, zoomed: false, attached: 1, ...over });
const vis = (o = {}) => isVisible({ render: render(), info: info(), now: NOW, pane: PANE, ...o });

/** Drive the tracker + fsm the way run.js does: sample every 500ms from the display start. */
function simulate(visibleAt, endAfterMs) {
  const fsm = new IdleStateMachine({ minWaitMs: 0, capPerHour: 6 });
  fsm.idleStart(0);
  assert.equal(fsm.tick(0)[0].type, 'display');
  const tr = new VisibilityTracker();
  for (let t = 0; t <= endAfterMs; t += 500) tr.sample(t, visibleAt(t));
  return fsm.idleEnd(endAfterMs, tr.billableMs()).find((a) => a.type === 'impression');
}

test('gate: render signal + active window of an attached session is visible — pane_active is NOT required', () => {
  assert.equal(vis({ info: info({ paneActive: false }) }), true, 'agent keeps focus, game still visible');
  assert.equal(vis({ info: info({ paneActive: true }) }), true);
});

test('gate: no render signal, stale, wrong pane or non-rendering → not visible', () => {
  assert.equal(vis({ render: null }), false);
  assert.equal(vis({ render: render({ ts: NOW - bridge.RENDER_STALE_MS - 1 }) }), false, 'play stopped beating (frozen/hung/killed)');
  assert.equal(vis({ render: render({ pane: '%9' }) }), false, 'another meshad play, not our split');
  assert.equal(vis({ render: render({ pane: null }) }), true, 'no pane in the file is accepted');
  assert.equal(vis({ render: render({ rendering: false }) }), false);
  assert.equal(vis({ render: render({ ts: NOW + 60_000 }) }), false, 'future timestamp');
});

test('gate: window inactive, session detached, pane dead or tmux unreadable → not visible', () => {
  assert.equal(vis({ info: info({ windowActive: false }) }), false);
  assert.equal(vis({ info: info({ attached: 0 }) }), false);
  assert.equal(vis({ info: info({ dead: true }) }), false);
  assert.equal(vis({ info: null }), false, 'cannot query tmux → never bill');
});

test('gate: a zoomed sibling pane hides the split; a zoomed split is visible', () => {
  assert.equal(vis({ info: info({ zoomed: true, paneActive: false }) }), false);
  assert.equal(vis({ info: info({ zoomed: true, paneActive: true }) }), true);
});

test('tracker: ≥2s continuous visibility bills, and duration_ms is the visible time', () => {
  const imp = simulate(() => true, 4000);
  assert.ok(imp);
  assert.equal(imp.displayed_ms, 4000);
});

test('tracker: render but window inactive (never visible) does not bill', () => {
  assert.equal(simulate(() => false, 10000), undefined);
});

test('tracker: visible only after the split opened is billed for the visible part only', () => {
  const imp = simulate((t) => t >= 3000, 6000);
  assert.equal(imp.displayed_ms, 3000, 'not 6000 since open');
});

test('tracker: two short visible bursts (each <2s) are not a continuous 2s → no bill', () => {
  assert.equal(simulate((t) => t < 1500 || (t >= 3000 && t < 4500), 8000), undefined);
});

test('tracker: a streak ≥2s counts total visible time, gaps excluded', () => {
  const imp = simulate((t) => t < 1000 || (t >= 3000 && t < 6000), 8000);
  assert.equal(imp.displayed_ms, 500 + 2500);
});

test('fsm: without visibleMs the legacy behaviour is unchanged', () => {
  const fsm = new IdleStateMachine({ minWaitMs: 0 });
  fsm.idleStart(0); fsm.tick(0);
  assert.equal(fsm.idleEnd(3000).find((a) => a.type === 'impression').displayed_ms, 3000);
  const fsm2 = new IdleStateMachine({ minWaitMs: 0 });
  fsm2.idleStart(0); fsm2.tick(0);
  const acts = fsm2.idleEnd(3000, 0);
  assert.equal(acts.find((a) => a.type === 'impression'), undefined);
  assert.equal(fsm2.history.length, 0, 'an unbilled unit does not consume the frequency cap');
});

test('render file: atomic, only {rendering,ts,pane}; garbage reads as null; clear removes it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-render-'));
  assert.equal(bridge.readRender(dir), null);
  bridge.writeRender(dir, 123, '%7');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, bridge.RENDER_FILE), 'utf8')), { rendering: true, ts: 123, pane: '%7' });
  bridge.writeRender(dir, 124, 'ad_secret; rm -rf');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, bridge.RENDER_FILE), 'utf8'))).sort(), ['rendering', 'ts'], 'pane id must look like %N');
  // independent of the heartbeat file: run overwriting play-state.json cannot erase the signal
  bridge.writeState(dir, 'waiting', 5);
  assert.equal(bridge.readRender(dir).ts, 124);
  for (const bad of ['nope', '{}', '{"rendering":false,"ts":1}', '{"rendering":true}']) {
    fs.writeFileSync(path.join(dir, bridge.RENDER_FILE), bad);
    assert.equal(bridge.readRender(dir), null, bad);
  }
  bridge.clearRender(dir);
  assert.equal(fs.existsSync(path.join(dir, bridge.RENDER_FILE)), false);
});

test('tmux.paneInfo: parses display-message, null on any failure', () => {
  const ok = (stdout) => () => ({ status: 0, stdout });
  assert.deepEqual(tmux.paneInfo('%7', { run: ok('%7 0 0 1 0 2\n') }), { dead: false, paneActive: false, windowActive: true, zoomed: false, attached: 2 });
  assert.equal(tmux.paneInfo('%7', { run: ok('%8 0 0 1 0 1\n') }), null, 'different pane answered');
  assert.equal(tmux.paneInfo('%7', { run: ok('garbage') }), null);
  assert.equal(tmux.paneInfo('%7', { run: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(tmux.paneInfo('%7', { run: () => null }), null);
  assert.equal(tmux.paneInfo(null, { run: ok('') }), null);
  let args;
  tmux.paneInfo('%7', { run: (...a) => (args = a, { status: 0, stdout: '' }) });
  assert.deepEqual(args[1].slice(0, 4), ['display-message', '-p', '-t', '%7']);
});

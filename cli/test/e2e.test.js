'use strict';

/**
 * End-to-end: the real `meshad` binary against a mock API.
 * Covers: init --yes, demo (full FSM + impression), run -- <cmd>,
 * status --explain, pause semantics.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startMockServer } = require('./helpers/mock-server');

const BIN = path.join(__dirname, '..', 'bin', 'meshad.js');

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function initialized(mockUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-e2e-'));
  const env = { MESHAD_CONFIG_DIR: dir, MESHAD_API_URL: mockUrl, NO_COLOR: '1' };
  const r = await cli(['init', '--yes', '--email', 'e2e@test.dev'], env);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return { dir, env };
}

test('e2e: demo completes the full flow and the mock receives a plausible impression', async () => {
  const mock = await startMockServer();
  const { env } = await initialized(mock.url);

  const r = await cli(['demo', '--wait', '6'], env);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /Done \(6\.0s\)/);

  const events = mock.received.events;
  const types = events.map((e) => e.event);
  assert.ok(types.includes('idle_start'), 'idle_start sent');
  assert.ok(types.includes('idle_end'), 'idle_end sent');

  const imp = events.find((e) => e.event === 'impression');
  assert.ok(imp, 'impression sent');
  assert.ok(imp.ad_id.startsWith('ad_mock'), 'impression references a real served ad');
  // demo min wait is 3s of a 6s wait → displayed ≈ 3s (2s minimum for billability)
  assert.ok(imp.duration_ms >= 2000 && imp.duration_ms <= 4500, `plausible duration, got ${imp.duration_ms}`);

  const idleEnd = events.find((e) => e.event === 'idle_end');
  assert.ok(idleEnd.duration_ms >= 5500 && idleEnd.duration_ms <= 8000, `full wait duration, got ${idleEnd.duration_ms}`);

  // every event carries ONLY contract fields
  const allowed = ['event', 'ts', 'anon_id', 'terminal_type', 'duration_ms', 'ad_id', 'sdk_version'];
  for (const e of events) {
    for (const k of Object.keys(e)) assert.ok(allowed.includes(k), `field ${k} is in the allowlist`);
  }
  await mock.close();
});

test('e2e: run -- wraps a command, forwards output untouched and detects the wait', async () => {
  const mock = await startMockServer();
  const { dir, env } = await initialized(mock.url);
  // min_wait 2s so the 4s of silence displays an ad (no TTY here → no render, but FSM + telemetry run)
  const cfgFile = path.join(dir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.min_wait_ms = 2000;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));

  const script = 'process.stdout.write("before\\n"); setTimeout(() => { process.stdout.write("after\\n"); }, 4000);';
  const r = await cli(['run', '--', process.execPath, '-e', script], env);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /before/, 'output forwarded');
  assert.match(r.stdout, /after/, 'output forwarded to the end');

  const types = mock.received.events.map((e) => e.event);
  assert.ok(types.includes('idle_start'), 'wait detected from output silence');
  assert.ok(types.includes('idle_end'), 'wait ended when output resumed');
  await mock.close();
});

test('e2e: status --explain shows the exact last batch bytes', async () => {
  const mock = await startMockServer();
  const { env } = await initialized(mock.url);
  await cli(['demo', '--wait', '4'], env);
  const r = await cli(['status', '--explain'], env);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /idle_start|idle_end/, 'batch bytes visible');
  assert.match(r.stdout, /\/v1\/telemetry\/events/, 'destination visible');
  await mock.close();
});

test('e2e: pause forever → demo shows no ad and sends no impression', async () => {
  const mock = await startMockServer();
  const { env } = await initialized(mock.url);
  const p = await cli(['pause', 'forever'], env);
  assert.equal(p.code, 0, p.stderr || p.stdout);

  await cli(['demo', '--wait', '5'], env);
  const imp = mock.received.events.find((e) => e.event === 'impression');
  assert.equal(imp, undefined, 'no impression while paused');
  await mock.close();
});

test('e2e: uninstall wipes the config dir', async () => {
  const mock = await startMockServer();
  const { dir, env } = await initialized(mock.url);
  const r = await cli(['uninstall', '--yes'], env);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.ok(!fs.existsSync(path.join(dir, 'config.json')), 'config removed');
  await mock.close();
});

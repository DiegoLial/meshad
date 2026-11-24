'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AdCache, PUBKEY_FILE, PUBKEY_TTL_MS } = require('../src/adcache');
const { sanitizeLine, sanitizeAnsiLine } = require('../src/render');
const { validateSpan } = require('../src/creative');

function setup({ body } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-pk-'));
  let t = 1_000_000;
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => body || { algorithm: 'ed25519', public_key_b64: `key${calls}` } };
  };
  const cache = new AdCache({ dir, apiUrl: 'http://x', fetchImpl, now: () => t });
  return { dir, cache, calls: () => calls, advance: (ms) => { t += ms; } };
}

test('pubkey: fresh cached key is reused without network', async () => {
  const s = setup();
  assert.equal(await s.cache.getPublicKey(), 'key1');
  s.advance(PUBKEY_TTL_MS - 1000);
  assert.equal(await s.cache.getPublicKey(), 'key1');
  assert.equal(s.calls(), 1);
});

test('pubkey: expired cached key is fetched again and rewritten', async () => {
  const s = setup();
  await s.cache.getPublicKey();
  s.advance(PUBKEY_TTL_MS + 1);
  assert.equal(await s.cache.getPublicKey(), 'key2');
  assert.equal(s.calls(), 2);
  const disk = JSON.parse(fs.readFileSync(path.join(s.dir, PUBKEY_FILE), 'utf8'));
  assert.equal(disk.public_key_b64, 'key2');
});

test('pubkey: legacy entry without fetched_at is refetched', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.dir, PUBKEY_FILE), JSON.stringify({ algorithm: 'ed25519', public_key_b64: 'old' }));
  assert.equal(await s.cache.getPublicKey(), 'key1');
});

test('pubkey: invalid refetch fails closed and does not overwrite the cache', async () => {
  const s = setup({ body: { algorithm: 'rsa', public_key_b64: 'evil' } });
  const file = path.join(s.dir, PUBKEY_FILE);
  fs.writeFileSync(file, JSON.stringify({ algorithm: 'ed25519', public_key_b64: 'old', fetched_at: 1_000_000 - PUBKEY_TTL_MS - 5 }));
  await assert.rejects(s.cache.getPublicKey(), /unexpected/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).public_key_b64, 'old');
});

test('sanitize: C1 controls (CSI 0x9B, OSC 0x9D) are stripped', () => {
  const evil = 'a\u009b2Jb\u009d0;pwn\u009cc\u0080d\u009fe\x7ff';
  for (const out of [sanitizeLine(evil, 80), sanitizeAnsiLine(evil, 80).text]) {
    assert.ok(!/[\x7f-\x9f]/.test(out), JSON.stringify(out));
  }
});

test('sanitizeAnsiLine: legitimate SGR still survives', () => {
  const { text } = sanitizeAnsiLine('\x1b[36mhello\x1b[0m \u009b31mx', 80);
  assert.ok(text.startsWith('\x1b[36mhello\x1b[0m'));
  assert.ok(!text.includes('\u009b'));
  assert.ok(text.includes('hello'));
});

test('creative: C1 payload rejected, plain text accepted', () => {
  assert.ok(validateSpan({ t: 'x\u009b2J' }, 'span').some((r) => r.includes('control_characters')));
  assert.ok(validateSpan({ t: 'x\u009d0;t' }, 'span').some((r) => r.includes('control_characters')));
  assert.deepEqual(validateSpan({ t: 'Fast builds ▲ çãõ', fg: 'cyan', bold: true }, 'span'), []);
});

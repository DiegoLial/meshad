'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { meshFetch, spkiSha256Base64, ALLOWED_HOSTS } = require('../src/net');

const realFetch = globalThis.fetch;
const realEnv = process.env.MESHAD_API_URL;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnv === undefined) delete process.env.MESHAD_API_URL;
  else process.env.MESHAD_API_URL = realEnv;
});

test('allowlisted hosts pass straight through to fetch', async () => {
  delete process.env.MESHAD_API_URL;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true };
  };
  for (const host of ALLOWED_HOSTS) {
    const r = await meshFetch(`https://${host}/v1/x`, { method: 'GET' });
    assert.equal(r.ok, true);
  }
  assert.equal(calls.length, ALLOWED_HOSTS.size);
});

test('a non-allowlisted host is refused before any connection', async () => {
  delete process.env.MESHAD_API_URL;
  globalThis.fetch = async () => assert.fail('fetch must not be reached');
  await assert.rejects(
    () => meshFetch('https://evil.example.com/steal'),
    /refusing egress to non-allowlisted host: evil\.example\.com/,
  );
});

test('the dev override (MESHAD_API_URL) allows exactly that host, with a warning', async () => {
  process.env.MESHAD_API_URL = 'http://127.0.0.1:9999';
  let reached = false;
  globalThis.fetch = async () => {
    reached = true;
    return { ok: true };
  };
  const warns = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (s) => {
    warns.push(String(s));
    return true;
  };
  try {
    await meshFetch('http://127.0.0.1:9999/v1/x');
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(reached, true);
  assert.ok(warns.join('').includes('DISABLED'), 'a loud carve-out warning is printed');

  // A different non-allowlisted host is still refused even with the override set.
  globalThis.fetch = async () => assert.fail('fetch must not be reached');
  await assert.rejects(() => meshFetch('http://127.0.0.1:8888/x'), /refusing egress/);
});

test('spkiSha256Base64 is the base64 SHA-256 of the DER SPKI', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const expected = crypto.createHash('sha256').update(der).digest('base64');
  // spkiSha256Base64 takes an X509-like object exposing publicKey.export.
  assert.equal(spkiSha256Base64({ publicKey }), expected);
});

'use strict';

/**
 * The CLI vendors its own copy of packages/schema (src/schema/) so it can
 * be installed standalone, outside the monorepo — see package.json's
 * comment-free absence of a `@meshad/schema` file: dependency. This test
 * is the tripwire against the two copies drifting apart, which would be a
 * silent privacy-contract bug (the client and the gateway validating
 * against two different allowlists).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const vendored = require('../src/schema');
const canonical = require(path.join(__dirname, '..', '..', '..', 'packages', 'schema'));

test('vendored schema constants match packages/schema exactly', () => {
  assert.deepEqual(vendored.TELEMETRY_SCHEMA, canonical.TELEMETRY_SCHEMA);
  assert.deepEqual(vendored.EVENT_TYPES, canonical.EVENT_TYPES);
  assert.deepEqual(vendored.TERMINAL_TYPES, canonical.TERMINAL_TYPES);
  assert.deepEqual(vendored.ALLOWED_FIELDS, canonical.ALLOWED_FIELDS);
  assert.deepEqual(vendored.REQUIRED_FIELDS, canonical.REQUIRED_FIELDS);
  assert.equal(vendored.SCHEMA_VERSION, canonical.SCHEMA_VERSION);
});

test('vendored validateEvent behaves identically to packages/schema on the same inputs', () => {
  const cases = [
    { event: 'idle_start', ts: new Date().toISOString(), anon_id: '9f0c1b2a-3d4e-4f5a-8b6c-7d8e9f0a1b2c', terminal_type: 'claude-code', sdk_version: '0.1.0' },
    { event: 'impression', ts: new Date().toISOString(), anon_id: '9f0c1b2a-3d4e-4f5a-8b6c-7d8e9f0a1b2c', terminal_type: 'claude-code', sdk_version: '0.1.0', ad_id: 'ad_mock1aaaa', duration_ms: 3000 },
    { event: 'idle_end', ts: 'not-a-date', anon_id: 'bad', terminal_type: 'nope', sdk_version: 'x' },
    { prompt: 'leaked' },
    {},
  ];
  for (const ev of cases) {
    assert.deepEqual(vendored.validateEvent(ev), canonical.validateEvent(ev), `mismatch for ${JSON.stringify(ev)}`);
  }
});

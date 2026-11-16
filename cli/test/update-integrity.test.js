'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { checksumMatches } = require('../src/commands/update');

const bytes = Buffer.from('a pretend tarball');
const good = crypto.createHash('sha256').update(bytes).digest('hex');

test('checksumMatches accepts a matching sha256sum line', () => {
  assert.equal(checksumMatches(bytes, `${good}  meshad-cli.tgz`), true);
  assert.equal(checksumMatches(bytes, good), true);
  assert.equal(checksumMatches(bytes, `${good.toUpperCase()}\n`), true);
});

test('checksumMatches refuses a mismatch, malformed, or empty checksum', () => {
  assert.equal(checksumMatches(bytes, 'f'.repeat(64)), false);
  assert.equal(checksumMatches(Buffer.from('tampered'), `${good}  x`), false);
  assert.equal(checksumMatches(bytes, 'not-a-hash'), false);
  assert.equal(checksumMatches(bytes, ''), false);
  assert.equal(checksumMatches(bytes, undefined), false);
});

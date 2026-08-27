'use strict';

/**
 * The CLI vendors its own copy of packages/creative (src/creative/) so it can be
 * installed standalone, outside the monorepo — exactly as it does for
 * packages/schema. This test is the tripwire against the two copies drifting,
 * which would be a silent security bug: the gateway approving a creative against
 * one styling allowlist while the client renders it against another.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const vendored = require('../src/creative');
const canonical = require(path.join(__dirname, '..', '..', '..', 'packages', 'creative'));

/** Everything after the leading doc comment. The two files deliberately carry
 *  different headers — one says "this is the contract", the other says "this is
 *  the vendored copy" — but a single byte of divergence below that is a bug. */
function body(file) {
  const source = fs.readFileSync(file, 'utf8');
  const m = /^\s*\/\*\*[\s\S]*?\*\/\r?\n/.exec(source);
  return m ? source.slice(m[0].length) : source;
}

test('vendored creative module body is identical to packages/creative', () => {
  const vendoredFile = path.join(__dirname, '..', 'src', 'creative', 'index.js');
  const canonicalFile = path.join(__dirname, '..', '..', '..', 'packages', 'creative', 'index.js');
  assert.equal(
    body(vendoredFile),
    body(canonicalFile),
    'apps/cli/src/creative/index.js has drifted from packages/creative/index.js — run: make sync-vendored',
  );
});

test('vendored creative constants match packages/creative exactly', () => {
  assert.deepEqual(vendored.FG_CODES, canonical.FG_CODES);
  assert.deepEqual(vendored.BG_CODES, canonical.BG_CODES);
  assert.deepEqual(vendored.ATTR_CODES, canonical.ATTR_CODES);
  assert.equal(vendored.MAX_ART_LINES, canonical.MAX_ART_LINES);
  assert.equal(vendored.MAX_LINE_WIDTH, canonical.MAX_LINE_WIDTH);
  assert.equal(vendored.MAX_SPANS_PER_LINE, canonical.MAX_SPANS_PER_LINE);
});

test('vendored validateArt behaves identically on the same inputs', () => {
  const cases = [
    { art_lines: [[{ t: 'ok', fg: 'bright_cyan', bold: true }]] },
    { art_lines: [[{ t: '\x1b[2J', fg: 'red' }]] },
    { art_lines: [[{ t: 'x', fg: 'not_a_colour' }]] },
    { art_lines: [] },
    { art_lines: null },
    {},
  ];
  for (const body of cases) {
    assert.deepEqual(vendored.validateArt(body), canonical.validateArt(body), `mismatch for ${JSON.stringify(body)}`);
  }
});

'use strict';

/**
 * Egress boundary — the JS-native, zero-dependency equivalent of the
 * whitepaper's "network symbols only in the uplink module". Every file under
 * src/ EXCEPT net.js must be free of network primitives. If anyone adds a raw
 * `fetch(`, a `node:http(s)/net/tls/dgram` import, or `globalThis.fetch`
 * outside net.js, this test fails the build — egress-in-one-module becomes an
 * enforced property, not a convention.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const ALLOWED_FILE = path.join(SRC, 'net.js');

/** Every .js under src/, recursively. */
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const PATTERNS = [
  // A bare `fetch(` call — not `this.fetch(`, not `meshFetch(` (capital F),
  // not `.fetch(`. The lookbehind excludes any `.` or word char before it.
  { re: /(?<![.\w])fetch\s*\(/, what: 'bare fetch() call' },
  { re: /\bglobalThis\.fetch\b|\bglobal\.fetch\b/, what: 'globalThis.fetch' },
  { re: /require\(\s*['"]node:(https?|net|tls|dgram)['"]\s*\)/, what: 'node network module import' },
  { re: /from\s+['"]node:(https?|net|tls|dgram)['"]/, what: 'node network module import' },
];

test('no file under src/ except net.js touches the network', () => {
  const violations = [];
  for (const file of jsFiles(SRC)) {
    if (file === ALLOWED_FILE) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const { re, what } of PATTERNS) {
        if (re.test(line)) {
          violations.push(`${path.relative(SRC, file)}:${i + 1} — ${what}: ${line.trim()}`);
        }
      }
    });
  }
  assert.deepStrictEqual(
    violations,
    [],
    `network egress must live only in net.js. Offenders:\n${violations.join('\n')}`,
  );
});

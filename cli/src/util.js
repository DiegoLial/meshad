'use strict';

/** Small shared helpers: ANSI colors, arg parsing, formatting. Zero deps. */

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  !!(process.stdout && process.stdout.isTTY);

function wrap(open, close) {
  return (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
}

const c = {
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  red: wrap(31, 39),
  cyan: wrap(36, 39),
};

/**
 * Tiny flag parser: parseFlags(['--wait','6','--yes'], {wait:'string', yes:'bool'})
 * → { flags: {wait:'6', yes:true}, rest: [] }. Unknown flags land in rest.
 */
function parseFlags(argv, spec = {}) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (spec[name] === 'bool') {
        flags[name] = true;
        continue;
      }
      if (spec[name] === 'string') {
        flags[name] = argv[++i];
        continue;
      }
    }
    rest.push(a);
  }
  return { flags, rest };
}

/** micros → "$0.0042" (trims trailing zeros, keeps at least 2 decimals). */
function usd(micros) {
  const v = (Number(micros) || 0) / 1e6;
  let s = v.toFixed(7).replace(/0+$/, '');
  if (s.endsWith('.')) s += '00';
  const dec = s.split('.')[1] || '';
  if (dec.length < 2) s = v.toFixed(2);
  return `$${s}`;
}

function platform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

const SDK_VERSION = require('../package.json').version;

module.exports = { c, parseFlags, usd, platform, pad, padLeft, SDK_VERSION };

'use strict';

const config = require('../config');
const { TERMINAL_TYPES } = require('../schema');
const { c, parseFlags, pad } = require('../util');

const HELP = `
  meshad config             — print the whole config
  meshad config <key>       — print one value
  meshad config <key> <val> — set a value

  Writable keys:
    api_url                 API base URL (env MESHAD_API_URL overrides)
    frequency_cap_h         max ads per hour (integer 0..6; hard cap is 6)
    min_wait_ms             minimum wait before an ad may appear (≥ 2000)
    terminal_type_default   one of: ${TERMINAL_TYPES.join(', ')}
`;

const WRITABLE = ['api_url', 'frequency_cap_h', 'min_wait_ms', 'terminal_type_default'];

module.exports = async function configCmd(_cmd, argv) {
  const { flags, rest } = parseFlags(argv, { help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = config.load();
  const [key, value] = rest;

  if (!key) {
    for (const k of config.CONFIG_KEYS) {
      const v = k === 'api_key' && cfg.api_key ? `${String(cfg.api_key).slice(0, 10)}…` : cfg[k];
      console.log(`  ${pad(k, 24)} ${v === null ? c.dim('null') : v}`);
    }
    return 0;
  }

  if (!(key in cfg)) {
    console.error(`${c.red('error:')} unknown key "${key}"`);
    return 2;
  }

  if (value === undefined) {
    console.log(cfg[key] === null ? 'null' : String(cfg[key]));
    return 0;
  }

  if (!WRITABLE.includes(key)) {
    console.error(`${c.red('error:')} "${key}" is not writable via config (managed by init/rotate-id/pause)`);
    return 2;
  }

  if (key === 'frequency_cap_h') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      console.error(`${c.red('error:')} frequency_cap_h must be an integer 0..6 (the network hard cap is 6/h)`);
      return 2;
    }
    cfg[key] = n;
  } else if (key === 'min_wait_ms') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 2000) {
      console.error(`${c.red('error:')} min_wait_ms must be an integer ≥ 2000`);
      return 2;
    }
    cfg[key] = n;
  } else if (key === 'terminal_type_default') {
    if (!TERMINAL_TYPES.includes(value)) {
      console.error(`${c.red('error:')} terminal_type must be one of: ${TERMINAL_TYPES.join(', ')}`);
      return 2;
    }
    cfg[key] = value;
  } else {
    cfg[key] = value;
  }

  config.save(cfg);
  console.log(`${c.green('✓')} ${key} = ${cfg[key]}`);
  return 0;
};

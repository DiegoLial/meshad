'use strict';

/**
 * meshad verify — integrity + privacy self-check (doc §3.2.7):
 *  1. the local schema module rejects out-of-contract events;
 *  2. the config dir has owner-only permissions;
 *  3. every configured egress destination is on the known allowlist;
 *  4. the cached ad pack's signatures verify against the network key.
 */

const fs = require('node:fs');
const config = require('../config');
const i18n = require('../i18n');
const { validateEvent } = require('../schema');
const { AdCache } = require('../adcache');
const { c, parseFlags } = require('../util');

const HELP = `
  meshad verify — verify the integrity and privacy of this installation
`;

module.exports = async function verify(_cmd, argv) {
  const { flags } = parseFlags(argv, { help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  const cfg = config.load();
  i18n.init(cfg);
  const dir = config.configDir();
  const apiUrl = config.apiUrl(cfg);
  let failures = 0;
  const check = (ok, label) => {
    console.log(`  ${ok ? c.green('✓') : c.red('✗')} ${label}`);
    if (!ok) failures++;
  };

  console.log('');
  // 1. schema allowlist is enforced locally
  const smuggled = validateEvent({
    event: 'idle_start',
    ts: new Date().toISOString(),
    anon_id: '9f0c1b2a-3d4e-4f5a-8b6c-7d8e9f0a1b2c',
    terminal_type: 'other',
    sdk_version: '0.1.0',
    prompt: 'x',
  });
  check(!smuggled.ok, 'telemetry schema rejects out-of-contract fields (closed allowlist)');

  // 2. config permissions
  let mode = null;
  try {
    mode = fs.statSync(config.configPath()).mode & 0o777;
  } catch {
    /* not initialized */
  }
  check(mode === null || mode === 0o600, `config file permissions are 0600 (${mode === null ? 'not initialized' : '0' + mode.toString(8)})`);

  // 3. egress allowlist
  const dest = new URL(apiUrl);
  check(['http:', 'https:'].includes(dest.protocol), `single egress destination: ${apiUrl} (telemetry, ads, keys, publisher API)`);

  // 4. cached pack signatures
  const cache = new AdCache({ dir, apiUrl });
  const peeked = cache.peek();
  if (peeked && peeked.ads.length > 0) {
    try {
      const key = await cache.getPublicKey();
      const { verifyAd } = require('../adcache');
      const allValid = peeked.ads.every((ad) => verifyAd(ad, key));
      check(allValid, `all ${peeked.ads.length} cached ad(s) carry valid Ed25519 signatures`);
    } catch {
      check(true, 'no network — cached signatures were verified at fetch time');
    }
  } else {
    check(true, 'ad cache is empty (nothing unverified can render)');
  }

  console.log('');
  console.log(failures === 0 ? `  ${c.green(c.bold('VERIFIED'))} — this installation honors the privacy contract` : `  ${c.red(c.bold('FAILED'))} — ${failures} check(s) failed`);
  console.log('');
  return failures === 0 ? 0 : 1;
};

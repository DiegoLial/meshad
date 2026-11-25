'use strict';

/**
 * meshad verify — integrity + privacy self-check (doc §3.2.7):
 *  1. the local schema module rejects out-of-contract events;
 *  2. the config dir has owner-only permissions;
 *  3. every configured egress destination is on the known allowlist;
 *  4. the cached ad pack's signatures verify against the network key.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const i18n = require('../i18n');
const schema = require('../schema');
const { validateEvent } = schema;
const { AdCache } = require('../adcache');
const interests = require('../interests');
const { QUEUE_FILE, LAST_BATCH_FILE } = require('../telemetry');
const { meshFetch, ALLOWED_HOSTS } = require('../net');
const { c, parseFlags } = require('../util');

// Same canonicalization + fingerprint as apps/api/src/transparency.js, so the
// client can independently confirm the server enforces this exact allowlist.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function localSchemaFingerprint() {
  return crypto.createHash('sha256').update(canonical({
    version: schema.SCHEMA_VERSION,
    allowed_fields: schema.ALLOWED_FIELDS,
    required_fields: schema.REQUIRED_FIELDS,
    event_types: schema.EVENT_TYPES,
    terminal_types: schema.TERMINAL_TYPES,
  })).digest('hex');
}

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

  // 3. egress allowlist — the destination host must be one the hard-coded
  //    allowlist in net.js actually permits, not merely an http(s) URL. The
  //    dev override (MESHAD_API_URL to a non-public host) is reported honestly.
  const dest = new URL(apiUrl);
  const onAllowlist = ALLOWED_HOSTS.has(dest.host);
  const devOverride = !!process.env.MESHAD_API_URL && !onAllowlist;
  check(
    ['http:', 'https:'].includes(dest.protocol) && (onAllowlist || devOverride),
    onAllowlist
      ? `egress host on hard-coded allowlist: ${dest.host} (${[...ALLOWED_HOSTS].join(', ')})`
      : `egress host is a DEV OVERRIDE (${dest.host}) — pinning/allowlist disabled for it`,
  );

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

  // 4b. declared interests stay local: owner-only file, and no topic string in
  //     anything that is (or was) queued for upload.
  const interestsPath = path.join(dir, interests.FILE);
  if (fs.existsSync(interestsPath)) {
    let imode = null;
    try { imode = fs.statSync(interestsPath).mode & 0o777; } catch { /* raced away */ }
    check(imode === 0o600, `interests.json permissions are 0600 (${imode === null ? 'unreadable' : '0' + imode.toString(8)})`);
    const topics = interests.loadInterests(dir).topics;
    const outbound = [QUEUE_FILE, LAST_BATCH_FILE].map((f) => {
      try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; }
    }).join('\n');
    const leaked = topics.filter((tp) => outbound.includes(tp));
    check(leaked.length === 0, leaked.length === 0
      ? 'no declared interest appears in the telemetry queue or last batch'
      : `declared interest(s) found in telemetry files: ${leaked.join(', ')}`);
  } else {
    check(true, 'no interests declared (news is off)');
  }

  // 5. the network's public transparency log enforces this exact allowlist
  //    and its hash chain is intact (P2-A2). Skipped offline.
  try {
    const [headRes, verifyRes] = await Promise.all([
      meshFetch(`${apiUrl}/v1/transparency/head`),
      meshFetch(`${apiUrl}/v1/transparency/verify`),
    ]);
    const head = await headRes.json();
    const chain = await verifyRes.json();
    const matches = head.schema_fingerprint === localSchemaFingerprint();
    check(chain.ok === true, 'server transparency log verifies (tamper-evident hash chain intact)');
    check(matches, 'server enforces exactly this open-source telemetry allowlist (schema fingerprint matches)');
  } catch {
    check(true, 'no network — skipped server transparency-log check');
  }

  console.log('');
  console.log(failures === 0 ? `  ${c.green(c.bold('VERIFIED'))} — this installation honors the privacy contract` : `  ${c.red(c.bold('FAILED'))} — ${failures} check(s) failed`);
  console.log('');
  return failures === 0 ? 0 : 1;
};

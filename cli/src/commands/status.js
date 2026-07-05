'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const i18n = require('../i18n');
const { AdCache } = require('../adcache');
const { LAST_BATCH_FILE, QUEUE_FILE } = require('../telemetry');
const { request } = require('../api');
const { c, parseFlags, usd, pad } = require('../util');

const HELP = `
  meshad status — daemon-less snapshot of the client

  Options:
    --explain   show the last telemetry batch sent, byte for byte, and
                every network destination this client is configured to use
    --help
`;

module.exports = async function status(_cmd, argv) {
  const { flags } = parseFlags(argv, { explain: 'bool', help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = config.load();
  i18n.init(cfg);
  const { t } = i18n;

  if (!config.exists()) {
    console.log(`${c.yellow(t('err.notInitialized'))} ${c.bold('meshad init')}`);
    return 1;
  }
  const apiUrl = config.apiUrl(cfg);
  const dir = config.configDir();

  if (flags.explain) {
    console.log('');
    console.log(`  ${c.bold(t('status.destinations'))} ${c.dim(t('status.destinationsNote'))}`);
    console.log(`    ${apiUrl}/v1/telemetry/events   ${c.dim(t('status.destTelemetry'))}`);
    console.log(`    ${apiUrl}/v1/ads/pack           ${c.dim(t('status.destPack'))}`);
    console.log(`    ${apiUrl}/v1/keys/public        ${c.dim(t('status.destKeys'))}`);
    console.log(`    ${apiUrl}/v1/publisher/*        ${c.dim(t('status.destPublisher'))}`);
    console.log('');
    console.log(`  ${c.bold(t('status.lastBatch'))} ${c.dim(`(${path.join(dir, LAST_BATCH_FILE)})`)}`);
    let raw = null;
    try {
      raw = fs.readFileSync(path.join(dir, LAST_BATCH_FILE), 'utf8');
    } catch {
      /* none yet */
    }
    if (!raw) {
      console.log(c.dim(`    ${t('status.noBatch')}`));
    } else {
      // byte for byte — exactly what left this machine, no reformatting
      process.stdout.write(raw.endsWith('\n') ? raw : raw + '\n');
    }
    return 0;
  }

  const paused = config.isPaused(cfg);
  const pausedLabel = !paused
    ? c.green(t('status.active'))
    : cfg.paused_until === 'forever'
      ? c.yellow(t('status.pausedForever'))
      : c.yellow(t('status.pausedUntil', { ts: new Date(Number(cfg.paused_until)).toISOString() }));

  console.log('');
  console.log(`  ${c.bold('meshad')} — ${pausedLabel}`);
  console.log('');
  console.log(`  ${pad(t('status.config'), 16)} ${config.configPath()}`);
  console.log(`  ${pad(t('status.api'), 16)} ${apiUrl}`);
  console.log(`  ${pad(t('status.anonId'), 16)} ${cfg.anon_id || c.dim(t('status.noneRunInit'))}`);
  console.log(`  ${pad(t('status.account'), 16)} ${cfg.account_id || c.dim(t('status.none'))}`);
  console.log(`  ${pad(t('status.terminal'), 16)} ${cfg.terminal_type_default}`);
  console.log(`  ${pad(t('status.minWait'), 16)} ${cfg.min_wait_ms}ms · ${t('status.freqCap')} ${cfg.frequency_cap_h}/h`);

  const cache = new AdCache({ dir, apiUrl }).peek();
  if (cache) {
    const fresh = Date.now() < cache.fetched_at + cache.ttl_seconds * 1000;
    const ttlLeft = Math.max(0, Math.round((cache.fetched_at + cache.ttl_seconds * 1000 - Date.now()) / 1000));
    console.log(
      `  ${pad(t('status.adPack'), 16)} ${cache.pack_id || '?'} · ${cache.ads.length} ad(s) · ${
        fresh ? c.green(t('status.fresh', { s: ttlLeft })) : c.yellow(t('status.expired'))
      }`
    );
    if (cache.invalid_dropped_total > 0) {
      console.log(`  ${pad(t('status.badSignatures'), 16)} ${c.red(String(cache.invalid_dropped_total))} ${t('status.dropped')}`);
    }
  } else {
    console.log(`  ${pad(t('status.adPack'), 16)} ${c.dim(t('status.noCache'))}`);
  }

  const queue = config.readJson(QUEUE_FILE, []);
  console.log(`  ${pad(t('status.queue'), 16)} ${queue.length} ${t('status.buffered')}`);

  if (cfg.api_key) {
    try {
      const e = await request(apiUrl, 'GET', '/v1/publisher/earnings?group_by=day', { apiKey: cfg.api_key, timeoutMs: 3000 });
      console.log(
        `  ${pad(t('status.earnings'), 16)} ${t('earnings.total')} ${usd(e.total_micros)} · ${t('earnings.pending')} ${usd(e.pending_micros)} · ${t('earnings.available')} ${usd(e.available_micros)}`
      );
    } catch {
      console.log(`  ${pad(t('status.earnings'), 16)} ${c.dim(t('status.unreachable'))}`);
    }
  }
  console.log('');
  return 0;
};

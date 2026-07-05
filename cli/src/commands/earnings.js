'use strict';

const config = require('../config');
const i18n = require('../i18n');
const { request } = require('../api');
const { c, parseFlags, usd, pad, padLeft } = require('../util');

const HELP = `
  meshad earnings — your earnings, straight from the ledger

  Options:
    --help
`;

module.exports = async function earnings(_cmd, argv) {
  const { flags } = parseFlags(argv, { help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = config.load();
  i18n.init(cfg);
  const { t } = i18n;

  if (!cfg.api_key) {
    console.error(`${c.red('error:')} ${t('err.notInitialized')} ${c.bold('meshad init')}`);
    return 1;
  }

  const e = await request(config.apiUrl(cfg), 'GET', '/v1/publisher/earnings?group_by=day', { apiKey: cfg.api_key });

  console.log('');
  console.log(`  ${c.bold(t('earnings.title'))} ${c.dim(`(${e.currency || 'USD'})`)}`);
  console.log('');
  console.log(`    ${pad(t('earnings.total'), 10)} ${c.bold(usd(e.total_micros))}`);
  console.log(`    ${pad(t('earnings.pending'), 10)} ${usd(e.pending_micros)} ${c.dim(t('earnings.pendingNote'))}`);
  console.log(`    ${pad(t('earnings.available'), 10)} ${c.green(usd(e.available_micros))}`);
  console.log('');

  const rows = Array.isArray(e.rows) ? e.rows : [];
  if (rows.length === 0) {
    console.log(c.dim(`    ${t('earnings.empty')}`));
  } else {
    console.log(
      `    ${pad(t('earnings.colDate'), 12)} ${padLeft(t('earnings.colImpressions'), 12)} ${padLeft(t('earnings.colClicks'), 8)} ${padLeft(t('earnings.colEarned'), 12)}`
    );
    console.log(c.dim(`    ${'─'.repeat(48)}`));
    for (const r of rows) {
      console.log(`    ${pad(r.date, 12)} ${padLeft(r.impressions, 12)} ${padLeft(r.clicks, 8)} ${padLeft(usd(r.earned_micros), 12)}`);
    }
  }
  console.log('');
  return 0;
};

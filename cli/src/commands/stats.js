'use strict';

const config = require('../config');
const i18n = require('../i18n');
const { request } = require('../api');
const { c, parseFlags, usd, pad, padLeft } = require('../util');

const HELP = `
  meshad stats — impressions, clicks, CTR and earnings per day
  meshad balance — balance summary (total / pending / available)

  Options: --help
`;

module.exports = async function stats(cmd, argv) {
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

  if (cmd === 'balance') {
    console.log('');
    console.log(`  ${pad(t('earnings.total'), 10)} ${c.bold(usd(e.total_micros))}`);
    console.log(`  ${pad(t('earnings.pending'), 10)} ${usd(e.pending_micros)}`);
    console.log(`  ${pad(t('earnings.available'), 10)} ${c.green(usd(e.available_micros))}`);
    console.log('');
    return 0;
  }

  const rows = e.rows || [];
  const imp = rows.reduce((s, r) => s + r.impressions, 0);
  const clk = rows.reduce((s, r) => s + r.clicks, 0);
  console.log('');
  console.log(`  ${c.bold(t('stats.title'))}`);
  console.log('');
  console.log(`    ${pad(t('earnings.colImpressions'), 14)} ${padLeft(imp, 10)}`);
  console.log(`    ${pad(t('earnings.colClicks'), 14)} ${padLeft(clk, 10)}`);
  console.log(`    ${pad('CTR', 14)} ${padLeft(imp > 0 ? ((clk / imp) * 100).toFixed(2) + '%' : '—', 10)}`);
  console.log(`    ${pad(t('earnings.colEarned'), 14)} ${padLeft(usd(e.total_micros), 10)}`);
  console.log('');
  return 0;
};

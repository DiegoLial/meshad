'use strict';

const config = require('../config');
const i18n = require('../i18n');
const { request } = require('../api');
const { c, parseFlags, usd, pad } = require('../util');

const HELP = `
  meshad payout — request a payout of your available balance

  Usage:
    meshad payout                    list payouts + method thresholds
    meshad payout <method> <usd>     request (methods: stripe, paypal, usdc, cloud_credits)

  Earnings mature from pending to available after 30 days; each method has
  its own minimum (stripe/paypal $10 · usdc $50 · cloud_credits $100).
`;

module.exports = async function payout(_cmd, argv) {
  const { flags, rest } = parseFlags(argv, { help: 'bool' });
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
  const apiUrl = config.apiUrl(cfg);

  if (rest.length === 0) {
    const res = await request(apiUrl, 'GET', '/v1/publisher/payouts', { apiKey: cfg.api_key });
    console.log('');
    console.log(`  ${c.bold(t('payout.title'))}`);
    console.log('');
    if (res.payouts.length === 0) {
      console.log(c.dim(`    ${t('payout.none')}`));
    } else {
      for (const p of res.payouts) {
        const tone = p.status === 'paid' ? c.green : p.status === 'failed' ? c.red : c.yellow;
        console.log(`    ${pad(p.id, 22)} ${pad(p.method, 14)} ${pad(usd(p.amount_micros), 12)} ${tone(p.status)}`);
      }
    }
    console.log('');
    console.log(c.dim(`    ${t('payout.methods')}: stripe/paypal ≥ $10 · usdc ≥ $50 · cloud_credits ≥ $100`));
    console.log('');
    return 0;
  }

  const [method, usdAmount] = rest;
  const amount = Math.round(Number(usdAmount) * 1e6);
  if (!Number.isInteger(amount) || amount <= 0) {
    console.error(`${c.red('error:')} usage: meshad payout <method> <usd>`);
    return 2;
  }
  try {
    const p = await request(apiUrl, 'POST', '/v1/publisher/payouts', {
      apiKey: cfg.api_key,
      body: { method, amount_micros: amount },
    });
    console.log(`${c.green('✓')} ${t('payout.requested', { id: p.id, amount: usd(p.amount_micros), method })}`);
    return 0;
  } catch (e) {
    console.error(`${c.red('error:')} ${e.message}`);
    return 1;
  }
};

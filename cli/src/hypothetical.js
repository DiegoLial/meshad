'use strict';

/**
 * The dev-mode ad pack: eight HYPOTHETICAL example campaigns, bundled with the
 * CLI. In dev_mode the client renders these instead of fetching the network
 * pack, so an integration test needs no connectivity, spends no one's budget,
 * and never shows a real advertiser inside a developer's experiments. Every
 * creative validates against @meshad/creative like a real one — the point is
 * to exercise the exact render path with stand-in content.
 *
 * Claims mirror each brand's public offers; they are examples, not ads.
 */

const L = (spans) => [spans];

function ad(id, cta, color, transition, frames) {
  return {
    ad_id: `hyp_${id}`,
    campaign_id: 'hypothetical',
    format: 'ascii_panel',
    min_wait_ms: 3000,
    pricing_model: 'cpm',
    price_micros: 0,
    signature: null, // bundled and trusted; never billed, never reported
    render: { text: '', lines: [''], cta, color, emoji: null, transition, loop: true, frames },
  };
}

const HYPOTHETICAL_ADS = [
  ad('vercel', 'vercel.com', 'cyan', 'typewriter', [
    { hold_ms: 1200, art_lines: L([{ t: '$ ', fg: 'bright_green', bold: true }, { t: 'git push', fg: 'bright_white' }]) },
    { hold_ms: 3000, art_lines: L([
      { t: '▲ ', fg: 'bright_white', bold: true },
      { t: 'preview no ar: ', fg: 'white' },
      { t: 'seu-app.vercel.app', fg: 'bright_cyan', bold: true },
      { t: ' — Hobby é grátis', fg: 'white' },
    ]) },
  ]),
  ad('docker', 'docker.com/build-cloud', 'blue', 'cut', [
    { hold_ms: 900, art_lines: L([{ t: 'build local  ', fg: 'white' }, { t: '████████████ 4m12s', fg: 'bright_black' }]) },
    { hold_ms: 700, art_lines: L([{ t: 'build local  ', fg: 'white' }, { t: '██████ 2m03s', fg: 'white' }]) },
    { hold_ms: 3000, art_lines: L([
      { t: 'Build Cloud  ', fg: 'bright_white', bold: true },
      { t: '█ 39s', fg: 'bright_cyan', bold: true },
      { t: '  ← até 39x mais rápido', fg: 'bright_yellow', bold: true },
    ]) },
  ]),
  ad('copilot', 'github.com/features/copilot', 'magenta', 'cut', [
    { hold_ms: 1100, art_lines: L([{ t: 'function parseAd(', fg: 'bright_white' }, { t: 'pack) { return pack.ads[0] }', fg: 'bright_black' }]) },
    { hold_ms: 3000, art_lines: L([
      { t: 'function parseAd(pack) { return pack.ads[0] }', fg: 'bright_white' },
      { t: '  ◉ Copilot — 30 dias grátis', fg: 'bright_magenta', bold: true },
    ]) },
  ]),
  ad('stripe', 'stripe.com', 'blue', 'cut', [
    { hold_ms: 700, art_lines: L([{ t: '✓ checkout', fg: 'bright_green', bold: true }]) },
    { hold_ms: 700, art_lines: L([{ t: '✓ checkout  ✓ assinaturas', fg: 'bright_green', bold: true }]) },
    { hold_ms: 3000, art_lines: L([
      { t: '✓ checkout  ✓ assinaturas  ✓ payouts   ', fg: 'bright_green', bold: true },
      { t: '▮ Stripe', fg: 'bright_blue', bold: true },
    ]) },
  ]),
  ad('mongodb', 'mongodb.com/atlas', 'green', 'cut', [
    { hold_ms: 600, art_lines: L([{ t: 'subindo cluster  ', fg: 'white' }, { t: '▇▇░░░░░░', fg: 'bright_green' }]) },
    { hold_ms: 600, art_lines: L([{ t: 'subindo cluster  ', fg: 'white' }, { t: '▇▇▇▇▇░░░', fg: 'bright_green' }]) },
    { hold_ms: 3000, art_lines: L([
      { t: '● Atlas pronto ', fg: 'bright_green', bold: true },
      { t: '— 512MB grátis, sem cartão', fg: 'bright_white' },
    ]) },
  ]),
  ad('aws', 'aws.amazon.com/activate', 'yellow', 'cut', [
    { hold_ms: 500, art_lines: L([{ t: 'créditos p/ startup  ', fg: 'white' }, { t: '$1.000', fg: 'bright_black', bold: true }]) },
    { hold_ms: 500, art_lines: L([{ t: 'créditos p/ startup  ', fg: 'white' }, { t: '$3.000', fg: 'white', bold: true }]) },
    { hold_ms: 3000, art_lines: L([
      { t: 'créditos p/ startup  ', fg: 'white' },
      { t: 'até $5.000', fg: 'bright_yellow', bold: true },
      { t: '  ☁ AWS Activate', fg: 'bright_white', bold: true },
    ]) },
  ]),
  ad('neon', 'neon.tech', 'green', 'cut', [
    { hold_ms: 900, art_lines: L([{ t: 'scale to zero  ', fg: 'white' }, { t: '────────────', fg: 'bright_black' }]) },
    { hold_ms: 600, art_lines: L([{ t: 'scale to zero  ', fg: 'white' }, { t: '────╱╲──────', fg: 'bright_green', bold: true }]) },
    { hold_ms: 3000, art_lines: L([
      { t: 'acordou em ms  ', fg: 'bright_white', bold: true },
      { t: 'Neon — Postgres serverless', fg: 'bright_green', bold: true },
    ]) },
  ]),
  ad('datadog', 'datadoghq.com', 'magenta', 'cut', [
    { hold_ms: 550, art_lines: L([{ t: 'p99  ', fg: 'white' }, { t: '──╱╲────────', fg: 'bright_magenta', bold: true }]) },
    { hold_ms: 550, art_lines: L([{ t: 'p99  ', fg: 'white' }, { t: '──────╱╲────', fg: 'bright_magenta', bold: true }]) },
    { hold_ms: 3000, art_lines: L([
      { t: 'viu o pico antes do cliente? ', fg: 'bright_white', bold: true },
      { t: 'Datadog — trial grátis', fg: 'bright_magenta', bold: true },
    ]) },
  ]),
];

module.exports = { HYPOTHETICAL_ADS };

'use strict';

/**
 * The dev-mode ad pack: HYPOTHETICAL example campaigns (fictional brands), bundled with the
 * CLI. In dev_mode the client renders these instead of fetching the network
 * pack, so an integration test needs no connectivity, spends no one's budget,
 * and never shows a real advertiser inside a developer's experiments. Every
 * creative validates against @meshad/creative like a real one — the point is
 * to exercise the exact render path with stand-in content.
 *
 * Every brand here is invented (Acme Cloud, Nimbus DB, Orbit CI…) — any
 * resemblance to a real product is coincidental. They are examples, not ads.
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
  ad('acmecloud', 'acmecloud.example', 'cyan', 'typewriter', [
    { hold_ms: 1200, art_lines: L([{ t: '$ ', fg: 'bright_green', bold: true }, { t: 'git push', fg: 'bright_white' }]) },
    { hold_ms: 3000, art_lines: L([
      { t: '▲ ', fg: 'bright_white', bold: true },
      { t: 'Acme Cloud · preview no ar: ', fg: 'white' },
      { t: 'seu-app.acmecloud.app', fg: 'bright_cyan', bold: true },
      { t: ' — plano Free', fg: 'white' },
    ]) },
  ]),
  ad('orbitci', 'orbit-ci.example', 'cyan', 'cut', [
    { hold_ms: 800, art_lines: [
      [{ t: 'build local  ', fg: 'white' }, { t: '████████████ 4m12s', fg: 'bright_black' }],
      [{ t: '                                  ', fg: 'white' }, { t: '⟨', fg: 'bright_black' }, { t: '▰▰', fg: 'green' }, { t: '▱▱▱▱▱▱▱▱', fg: 'bright_black' }, { t: '⟩ ', fg: 'bright_black' }, { t: '1x', fg: 'white' }],
    ] },
    { hold_ms: 700, art_lines: [
      [{ t: 'build local  ', fg: 'white' }, { t: '██████ 2m03s', fg: 'white' }],
      [{ t: '                                  ', fg: 'white' }, { t: '⟨', fg: 'bright_black' }, { t: '▰▰▰', fg: 'green' }, { t: '▰▰▰', fg: 'bright_cyan', bold: true }, { t: '▱▱▱▱', fg: 'bright_black' }, { t: '⟩ ', fg: 'bright_black' }, { t: '9x', fg: 'bright_cyan', bold: true }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: 'Orbit CI      ', fg: 'bright_white', bold: true }, { t: '█ 39s', fg: 'bright_cyan', bold: true }],
      [{ t: '↑ até 39x mais rápido             ', fg: 'bright_yellow', bold: true }, { t: '⟨', fg: 'bright_black' }, { t: '▰▰▰', fg: 'green' }, { t: '▰▰▰', fg: 'bright_cyan', bold: true }, { t: '▰▰▰▰', fg: 'bright_yellow', bold: true }, { t: '⟩ ', fg: 'bright_black' }, { t: '39x ⚡', fg: 'bright_yellow', bold: true }],
    ] },
  ]),
  ad('nimbusassist', 'nimbus-assist.example', 'magenta', 'cut', [
    { hold_ms: 1100, art_lines: L([{ t: 'function parseAd(', fg: 'bright_white' }, { t: 'pack) { return pack.ads[0] }', fg: 'bright_black' }]) },
    { hold_ms: 3000, art_lines: L([
      { t: 'function parseAd(pack) { return pack.ads[0] }', fg: 'bright_white' },
      { t: '  ◉ Nimbus — 30 dias grátis', fg: 'bright_magenta', bold: true },
    ]) },
  ]),
  ad('tallypay', 'tallypay.example', 'blue', 'cut', [
    { hold_ms: 700, art_lines: L([{ t: '✓ checkout', fg: 'bright_green', bold: true }]) },
    { hold_ms: 700, art_lines: L([{ t: '✓ checkout  ✓ assinaturas', fg: 'bright_green', bold: true }]) },
    { hold_ms: 3000, art_lines: L([
      { t: '✓ checkout  ✓ assinaturas  ✓ payouts   ', fg: 'bright_green', bold: true },
      { t: '▮ Tallypay', fg: 'bright_blue', bold: true },
    ]) },
  ]),
  ad('nimbusdb', 'nimbusdb.example', 'green', 'cut', [
    { hold_ms: 600, art_lines: L([{ t: 'subindo cluster  ', fg: 'white' }, { t: '▇▇░░░░░░', fg: 'bright_green' }]) },
    { hold_ms: 600, art_lines: L([{ t: 'subindo cluster  ', fg: 'white' }, { t: '▇▇▇▇▇░░░', fg: 'bright_green' }]) },
    { hold_ms: 3000, art_lines: L([
      { t: '● Nimbus DB pronto ', fg: 'bright_green', bold: true },
      { t: '— 512MB grátis, sem cartão', fg: 'bright_white' },
    ]) },
  ]),
  ad('stratus', 'stratus-startups.example', 'yellow', 'cut', [
    { hold_ms: 500, art_lines: L([{ t: 'créditos p/ startup  ', fg: 'white' }, { t: '$1.000', fg: 'bright_black', bold: true }]) },
    { hold_ms: 500, art_lines: L([{ t: 'créditos p/ startup  ', fg: 'white' }, { t: '$3.000', fg: 'white', bold: true }]) },
    { hold_ms: 3000, art_lines: L([
      { t: 'créditos p/ startup  ', fg: 'white' },
      { t: 'até $5.000', fg: 'bright_yellow', bold: true },
      { t: '  ☁ Stratus Startups', fg: 'bright_white', bold: true },
    ]) },
  ]),
  ad('zenithdb', 'zenithdb.example', 'green', 'cut', [
    { hold_ms: 700, art_lines: [
      [{ t: '▊▊▊▊▊▊▊▊▊▊  ', fg: 'bright_green', bold: true }, { t: '4 CU · $0.26/h', fg: 'bright_white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 500, art_lines: [
      [{ t: '▊▊▊▊▊', fg: 'bright_green', bold: true }, { t: '░░░░░  ', fg: 'bright_black' }, { t: '2 CU · $0.13/h', fg: 'white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 1000, art_lines: [
      [{ t: '·', fg: 'bright_black' }, { t: '           0 CU · ', fg: 'bright_black' }, { t: '$0.00/h', fg: 'bright_green', bold: true }, { t: '  zZz', fg: 'bright_black' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '⚡', fg: 'bright_yellow', bold: true }, { t: '▊▊▊▊▊▊▊▊▊▊  ', fg: 'bright_green', bold: true }, { t: 'acordou em 10ms — a todo vapor', fg: 'bright_white', bold: true }],
      [{ t: 'Zenith DB — Postgres que dorme quando você dorme', fg: 'bright_green', bold: true }],
    ] },
  ]),
  ad('vantage', 'vantage-metrics.example', 'magenta', 'cut', [
    { hold_ms: 500, art_lines: [
      [{ t: 'p99 ┤', fg: 'bright_black' }, { t: '      ▐█                  ', fg: 'bright_magenta', bold: true }],
      [{ t: '    ┤', fg: 'bright_black' }, { t: '      ██▌                 ', fg: 'bright_magenta', bold: true }],
      [{ t: ' ms ┼', fg: 'bright_black' }, { t: '─▁▂▁──▟█▙▄─▁────▂▁──▁─▂──▁', fg: 'magenta' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 500, art_lines: [
      [{ t: 'p99 ┤', fg: 'bright_black' }, { t: '   ▐█                     ', fg: 'bright_magenta', bold: true }],
      [{ t: '    ┤', fg: 'bright_black' }, { t: '   ██▌                    ', fg: 'bright_magenta', bold: true }],
      [{ t: ' ms ┼', fg: 'bright_black' }, { t: '▁──▟█▙▄─▁────▂▁──▁─▂──▁▂▁─', fg: 'magenta' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 500, art_lines: [
      [{ t: 'p99 ┤', fg: 'bright_black' }, { t: '▐█                      ▐█', fg: 'bright_magenta', bold: true }],
      [{ t: '    ┤', fg: 'bright_black' }, { t: '██▌                     ██', fg: 'bright_magenta', bold: true }],
      [{ t: ' ms ┼', fg: 'bright_black' }, { t: '▟█▙▄─▁────▂▁──▁─▂──▁▂▁──▟█', fg: 'magenta' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: 'p99 ┤', fg: 'bright_black' }, { t: '                     ▐█ ', fg: 'bright_red', bold: true }, { t: '← pico às 3:07', fg: 'bright_red', bold: true }],
      [{ t: '    ┤', fg: 'bright_black' }, { t: '                     ', fg: 'white' }, { t: '██▌', fg: 'bright_red', bold: true }],
      [{ t: ' ms ┼', fg: 'bright_black' }, { t: '▄─▁────▂▁──▁─▂──▁▂▁──', fg: 'magenta' }, { t: '▟█▙▄─', fg: 'bright_red', bold: true }],
      [{ t: 'viu o pico antes do cliente? ', fg: 'bright_white', bold: true }, { t: 'Vantage Metrics', fg: 'bright_magenta', bold: true }],
    ] },
  ]),
  // batch 3 — techniques the pack didn't exercise yet: marquee slide-in,
  // decode-from-noise, slot machine, breathing-cursor CTA.
  ad('edgewing', 'edgewing.example', 'yellow', 'cut', [
    { hold_ms: 500, art_lines: L([{ t: '                    ⚡ Edgewing', fg: 'bright_yellow', bold: true }]) },
    { hold_ms: 500, art_lines: L([{ t: '        ⚡ Edgewing Workers', fg: 'bright_yellow', bold: true }]) },
    { hold_ms: 3000, art_lines: L([
      { t: '⚡ Edgewing Workers ', fg: 'bright_yellow', bold: true },
      { t: '— 100 mil requests/dia no free tier', fg: 'bright_white' },
    ]) },
  ]),
  ad('tidewire', 'tidewire.example', 'cyan', 'cut', [
    { hold_ms: 500, art_lines: L([{ t: '▓#k2@%9 x!▒ f7*░q ▓@!', fg: 'bright_black' }]) },
    { hold_ms: 500, art_lines: L([{ t: '▓ail2@ale x!▒ conec░ado', fg: 'white' }]) },
    { hold_ms: 3000, art_lines: L([
      { t: '✓ tailnet no ar ', fg: 'bright_green', bold: true },
      { t: '— 100 devices, 3 usuários, grátis  ', fg: 'bright_white' },
      { t: 'Tidewire', fg: 'bright_cyan', bold: true },
    ]) },
  ]),
  ad('stackbloom', 'stackbloom.example', 'green', 'cut', [
    { hold_ms: 500, art_lines: L([{ t: '▌ ', fg: 'bright_black' }, { t: 'auth', fg: 'bright_green', bold: true }, { t: ' ▐', fg: 'bright_black' }]) },
    { hold_ms: 500, art_lines: L([{ t: '▌ ', fg: 'bright_black' }, { t: 'storage', fg: 'bright_green', bold: true }, { t: ' ▐', fg: 'bright_black' }]) },
    { hold_ms: 500, art_lines: L([{ t: '▌ ', fg: 'bright_black' }, { t: 'realtime', fg: 'bright_green', bold: true }, { t: ' ▐', fg: 'bright_black' }]) },
    { hold_ms: 3000, art_lines: L([
      { t: '● auth · storage · realtime ', fg: 'bright_green', bold: true },
      { t: '— tudo num Postgres. ', fg: 'bright_white' },
      { t: 'Stackbloom', fg: 'bright_green', bold: true },
    ]) },
  ]),
  ad('quickcache', 'quickcache.example', 'red', 'cut', [
    { hold_ms: 700, art_lines: L([{ t: '> ', fg: 'bright_green', bold: true }, { t: 'GET user:42', fg: 'bright_white' }, { t: ' ▌', fg: 'white' }]) },
    { hold_ms: 700, art_lines: L([{ t: '> ', fg: 'bright_green', bold: true }, { t: 'GET user:42', fg: 'bright_white' }, { t: '  →  0.2 ms', fg: 'bright_red', bold: true }]) },
    { hold_ms: 1500, art_lines: L([{ t: '⚡ Quickcache — 30MB grátis', fg: 'bright_red', bold: true }, { t: ' ▌', fg: 'white' }]) },
    { hold_ms: 1500, art_lines: L([{ t: '⚡ Quickcache — 30MB grátis', fg: 'bright_red', bold: true }, { t: '  ', fg: 'white' }]) },
  ]),
  // batch 4 — o lote AGRESSIVO: arte de blocos ocupando as 5 linhas do
  // contrato, não uma linha de texto com emoji. Glitch, corrida de barras,
  // mapa acendendo, ondas, gráfico com pico.
  ad('bugwatch', 'bugwatch.example', 'red', 'cut', [
    { hold_ms: 500, art_lines: [
      [{ t: '▓▒░█▒▓░ ▒█▓░▒ ░▓█▒░▓ █░▒▓░█ ▒░▓█░▒', fg: 'red' }],
      [{ t: '░█▓▒░▓█ ░▒▓█░ ▒█░▓▒░ ▓▒█░▓▒ █▓░▒▓░', fg: 'bright_black' }],
      [{ t: '▒░▓█░▒▓ █▓░▒█ ░▒▓░█▒ ░█▒▓░█ ▓░█▒░▓', fg: 'red' }],
    ] },
    { hold_ms: 500, art_lines: [
      [{ t: '▓▒░█▒▓░ ', fg: 'red' }, { t: 'ERRO 500', fg: 'bright_white', bold: true }, { t: ' ░▓█▒░▓ █░▒▓░█', fg: 'red' }],
      [{ t: '░█▓▒░▓█ ', fg: 'bright_black' }, { t: 'EM PRODUÇÃO', fg: 'bright_red', bold: true }, { t: ' ▓▒█░▓▒ █▓░▒▓', fg: 'bright_black' }],
      [{ t: '▒░▓█░▒▓ █▓░▒█ ░▒▓░█▒ ░█▒▓░█ ▓░█▒░▓', fg: 'red' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '█▄▄ █ █ █▀▀', fg: 'bright_red', bold: true }],
      [{ t: '█▄█ █▄█ █▄█', fg: 'bright_red', bold: true }],
      [{ t: 'você vê o erro ', fg: 'bright_white', bold: true }, { t: 'antes', fg: 'bright_red', bold: true }, { t: ' do usuário', fg: 'bright_white', bold: true }],
    ] },
  ]),
  ad('zip', 'zip-runtime.example', 'yellow', 'cut', [
    { hold_ms: 700, art_lines: [
      [{ t: 'old install   ', fg: 'white' }, { t: '▓▓▓▓▓░░░░░░░░░░░░░░░', fg: 'bright_black' }, { t: '  ...', fg: 'bright_black' }],
      [{ t: 'zip install   ', fg: 'bright_white', bold: true }, { t: '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓', fg: 'bright_yellow', bold: true }, { t: '  ✔', fg: 'bright_green', bold: true }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 700, art_lines: [
      [{ t: 'old install   ', fg: 'white' }, { t: '▓▓▓▓▓▓▓▓░░░░░░░░░░░░', fg: 'bright_black' }, { t: '  ...', fg: 'bright_black' }],
      [{ t: 'zip install   ', fg: 'bright_white', bold: true }, { t: '▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓', fg: 'bright_yellow', bold: true }, { t: '  ✔ há 12s', fg: 'bright_green', bold: true }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '▀▀█ █ █▀█', fg: 'bright_yellow', bold: true }, { t: '   o resto do mundo', fg: 'white' }],
      [{ t: '█▄▄ █ █▀▀', fg: 'bright_yellow', bold: true }, { t: '   ainda instalando…', fg: 'bright_black' }],
      [{ t: '  ', fg: 'yellow' }, { t: '  runtime + bundler + test runner', fg: 'bright_white' }],
    ] },
  ]),
  ad('skyhop', 'skyhop.example', 'magenta', 'cut', [
    { hold_ms: 600, art_lines: [
      [{ t: '  ·    ·      ·        ·     ·    ·  ', fg: 'bright_black' }],
      [{ t: '     ·    ', fg: 'bright_black' }, { t: '●', fg: 'bright_magenta', bold: true }, { t: '      ·        ·       ·  ', fg: 'bright_black' }],
      [{ t: '  ·      ·       ·        ·      ·   ', fg: 'bright_black' }],
    ] },
    { hold_ms: 600, art_lines: [
      [{ t: '  ·    ', fg: 'bright_black' }, { t: '●', fg: 'bright_magenta', bold: true }, { t: '      ·        ', fg: 'bright_black' }, { t: '●', fg: 'bright_magenta', bold: true }, { t: '     ·    ·  ', fg: 'bright_black' }],
      [{ t: '     ·    ', fg: 'bright_black' }, { t: '●', fg: 'bright_magenta', bold: true }, { t: '      ·        ', fg: 'bright_black' }, { t: '●', fg: 'bright_magenta', bold: true }, { t: '       ·  ', fg: 'bright_black' }],
      [{ t: '  ·      ', fg: 'bright_black' }, { t: '●', fg: 'bright_magenta', bold: true }, { t: '       ·        ·      ', fg: 'bright_black' }, { t: '●', fg: 'bright_magenta', bold: true }, { t: '   ', fg: 'bright_black' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ●', fg: 'bright_magenta', bold: true }],
      [{ t: '✈ Skyhop ', fg: 'bright_white', bold: true }, { t: '— seu app a ms do usuário,', fg: 'bright_white' }],
      [{ t: '  no mundo inteiro. ', fg: 'bright_white' }, { t: 'deploy em minutos', fg: 'bright_magenta', bold: true }],
    ] },
  ]),
  ad('tidepool', 'tidepool.example', 'blue', 'cut', [
    { hold_ms: 550, art_lines: [
      [{ t: '≈≈~≈≈≈~~≈≈≈≈~≈≈~≈≈≈≈~~≈≈≈~≈≈≈≈~≈≈', fg: 'blue' }],
      [{ t: '~≈≈≈~≈≈≈≈~≈≈≈≈~~≈≈~≈≈≈≈~≈≈≈~≈≈≈≈~', fg: 'bright_blue' }],
      [{ t: '≈~≈≈≈≈~≈≈~≈≈≈≈≈~≈≈≈≈~≈≈~≈≈≈≈~≈≈≈≈', fg: 'blue' }],
    ] },
    { hold_ms: 550, art_lines: [
      [{ t: '~≈≈≈~≈≈≈≈~≈≈≈≈~~≈≈~≈≈≈≈~≈≈≈~≈≈≈≈~', fg: 'bright_blue' }],
      [{ t: '≈≈~≈≈≈~~≈≈≈≈~≈≈~≈≈≈≈~~≈≈≈~≈≈≈≈~≈≈', fg: 'blue' }],
      [{ t: '~≈≈≈~≈≈≈≈~≈≈≈≈~~≈≈~≈≈≈≈~≈≈≈~≈≈≈≈~', fg: 'bright_blue' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '≈≈~≈≈ ', fg: 'blue' }, { t: '▀█▀ █▀▀', fg: 'bright_white', bold: true }, { t: ' ≈~≈≈≈≈~≈≈~≈≈≈≈≈~≈≈', fg: 'blue' }],
      [{ t: '~≈≈≈≈ ', fg: 'bright_blue' }, { t: '  █  █▄▄', fg: 'bright_white', bold: true }, { t: ' ≈≈~≈≈≈~~≈≈≈≈~≈≈~≈≈', fg: 'bright_blue' }],
      [{ t: 'US$ 200 de crédito ', fg: 'bright_cyan', bold: true }, { t: 'para testar por 60 dias', fg: 'bright_white' }],
    ] },
  ]),
  ad('dashly', 'dashly.example', 'yellow', 'cut', [
    { hold_ms: 550, art_lines: [
      [{ t: '                                    ', fg: 'white' }],
      [{ t: '            ▂▃▂                     ', fg: 'yellow' }],
      [{ t: '▁▂▃▂▁▂▄▃▂▃▄▅▆▅▄▃▂▁▂▃▂▁▂▁▂▃▄▃▂▁▂▃▂▁', fg: 'bright_yellow' }],
    ] },
    { hold_ms: 550, art_lines: [
      [{ t: '              █                     ', fg: 'bright_red', bold: true }],
      [{ t: '            ▄▆█▆▄                   ', fg: 'yellow' }],
      [{ t: '▁▂▃▂▁▂▄▃▂▃▄▅▆█▆▅▄▃▂▃▂▁▂▁▂▃▄▃▂▁▂▃▂▁', fg: 'bright_yellow' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '              █ ← ', fg: 'bright_red', bold: true }, { t: 'esse pico às 3h da manhã', fg: 'bright_white', bold: true }],
      [{ t: '            ▄▆█▆▄                   ', fg: 'yellow' }],
      [{ t: '◮ Dashly Cloud ', fg: 'bright_yellow', bold: true }, { t: '— dashboards grátis, pra sempre', fg: 'bright_white' }],
    ] },
  ]),
  ad('pagegen', 'pagegen.example', 'cyan', 'cut', [
    { hold_ms: 900, art_lines: [
      [{ t: '> ', fg: 'bright_cyan', bold: true }, { t: 'uma página de preços, dark, 3 planos', fg: 'bright_white' }],
      [{ t: ' ', fg: 'white' }], [{ t: ' ', fg: 'white' }], [{ t: ' ', fg: 'white' }], [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 500, art_lines: [
      [{ t: '> ', fg: 'bright_cyan', bold: true }, { t: 'uma página de preços, dark, 3 planos', fg: 'bright_black' }],
      [{ t: '▒▓░▒▓▒░ ▓▒░▒▓░▒ ░▒▓▒░▓▒', fg: 'bright_black' }],
      [{ t: '░▒▓░▒▓▒ ▒▓░▓▒░▓ ▓▒░▓▒░▓', fg: 'cyan' }],
      [{ t: '▓░▒▓▒░▓ ░▒▓▒░▒▓ ▒░▓░▒▓░', fg: 'bright_black' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 700, art_lines: [
      [{ t: '> ', fg: 'bright_cyan', bold: true }, { t: 'uma página de preços, dark, 3 planos', fg: 'bright_black' }],
      [{ t: '╭──────╮ ╭──────╮ ╭──────╮', fg: 'white' }],
      [{ t: '│  $0  │ │ $29  │ │ $99  │', fg: 'white' }],
      [{ t: '╰──────╯ ╰──────╯ ╰──────╯', fg: 'white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '> ', fg: 'bright_cyan', bold: true }, { t: 'uma página de preços, dark, 3 planos', fg: 'bright_black' }],
      [{ t: '╭──────╮ ', fg: 'white' }, { t: '╔══════╗', fg: 'bright_cyan', bold: true }, { t: ' ╭──────╮', fg: 'white' }],
      [{ t: '│  $0  │ ', fg: 'white' }, { t: '║ $29 ★║', fg: 'bright_cyan', bold: true }, { t: ' │ $99  │', fg: 'white' }],
      [{ t: '╰──────╯ ', fg: 'white' }, { t: '╚══════╝', fg: 'bright_cyan', bold: true }, { t: ' ╰──────╯', fg: 'white' }],
      [{ t: '◆ Pagegen — ', fg: 'bright_white', bold: true }, { t: 'prompt entra, React + Tailwind sai', fg: 'bright_cyan', bold: true }],
    ] },
  ]),
  ad('tasklane', 'tasklane.example', 'magenta', 'typewriter', [
    { hold_ms: 900, art_lines: [
      [{ t: '⌨ ', fg: 'bright_white', bold: true }, { t: '[C] nova issue → [⌘⏎] atribuída a você', fg: 'bright_white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '▰ Tasklane — feito em 0,4s, sem tocar o mouse', fg: 'bright_magenta', bold: true }],
      [{ t: ' ', fg: 'white' }],
    ] },
  ]),
  ad('tallyfx', 'tallypay.example/global', 'blue', 'cut', [
    { hold_ms: 500, art_lines: [
      [{ t: '$ 49.00 USD → ', fg: 'bright_white', bold: true }, { t: 'R$ 268,90', fg: 'bright_green', bold: true }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 500, art_lines: [
      [{ t: '$ 49.00 USD → ', fg: 'bright_white', bold: true }, { t: '€ 45,10', fg: 'bright_green', bold: true }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 500, art_lines: [
      [{ t: '$ 49.00 USD → ', fg: 'bright_white', bold: true }, { t: '¥ 7,301', fg: 'bright_green', bold: true }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: 'USD BRL EUR JPY GBP ', fg: 'bright_green', bold: true }, { t: '+131', fg: 'bright_yellow', bold: true }],
      [{ t: '▮ Tallypay — ', fg: 'bright_blue', bold: true }, { t: 'venda em 135+ moedas', fg: 'bright_white' }],
    ] },
  ]),
  ad('orbitscan', 'orbit-ci.example/scan', 'cyan', 'cut', [
    { hold_ms: 700, art_lines: [
      [{ t: '▍scout quickview  ', fg: 'bright_white', bold: true }, { t: '▓▓▓░░░░░', fg: 'bright_cyan' }, { t: ' escaneando…', fg: 'bright_black' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 600, art_lines: [
      [{ t: '▍scout quickview  ', fg: 'bright_white', bold: true }, { t: '▓▓▓▓▓▓▓▓', fg: 'bright_cyan', bold: true }, { t: ' ok', fg: 'white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '🛡 ', fg: 'bright_green', bold: true }, { t: '0 críticas · 0 altas', fg: 'bright_green', bold: true }],
      [{ t: '◆ Orbit Scan — ', fg: 'bright_white', bold: true }, { t: 'pode publicar', fg: 'bright_cyan', bold: true }],
    ] },
  ]),
  ad('assistcli', 'nimbus-assist.example/cli', 'magenta', 'typewriter', [
    { hold_ms: 900, art_lines: [
      [{ t: '$ ', fg: 'bright_green', bold: true }, { t: 'nimbus suggest ', fg: 'bright_white' }, { t: '"ache arquivos de 100MB"', fg: 'white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '▸ ', fg: 'bright_magenta', bold: true }, { t: 'find . -type f -size +100M -mtime -1', fg: 'bright_white', bold: true }],
      [{ t: '◉ Nimbus Assist CLI — ', fg: 'bright_magenta', bold: true }, { t: 'Linux em linguagem natural', fg: 'bright_white' }],
    ] },
  ]),
  ad('nimbusvector', 'nimbusdb.example/vector', 'green', 'typewriter', [
    { hold_ms: 1000, art_lines: [
      [{ t: 'db.vectorSearch({ v: ', fg: 'bright_white' }, { t: '[0.12, -0.98, 0.44]', fg: 'bright_green', bold: true }, { t: ' })', fg: 'bright_white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 600, art_lines: [
      [{ t: '▹▹▹▹▹▹▹▹▹▹▹▹ ', fg: 'green' }, { t: 'varrendo embeddings…', fg: 'bright_black' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '● ', fg: 'bright_green', bold: true }, { t: '100 matches mais próximos · 3ms', fg: 'bright_white', bold: true }],
      [{ t: 'Nimbus DB', fg: 'bright_green', bold: true }],
    ] },
  ]),
  ad('acmeedge', 'acmecloud.example/edge', 'cyan', 'cut', [
    { hold_ms: 700, art_lines: [
      [{ t: '◔ ', fg: 'bright_cyan', bold: true }, { t: 'roteando pela edge…', fg: 'white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 600, art_lines: [
      [{ t: 'GRU ▸2ms', fg: 'bright_green', bold: true }, { t: '   SFO ▸--   FRA ▸--   NRT ▸--', fg: 'bright_black' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 600, art_lines: [
      [{ t: 'GRU ▸2ms   SFO ▸12ms', fg: 'bright_green', bold: true }, { t: '   FRA ▸--   NRT ▸--', fg: 'bright_black' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: 'GRU ▸2ms   SFO ▸12ms   FRA ▸18ms   NRT ▸21ms', fg: 'bright_green', bold: true }],
      [{ t: '▲ Acme Cloud — ', fg: 'bright_white', bold: true }, { t: 'zero cold starts, em qualquer lugar da Terra', fg: 'bright_white', bold: true }],
    ] },
  ]),
  ad('zenithbranch', 'zenithdb.example/branch', 'green', 'wipe', [
    { hold_ms: 900, art_lines: [
      [{ t: '⎇ ', fg: 'bright_green', bold: true }, { t: 'db branch create dev-migration', fg: 'bright_white' }],
      [{ t: ' ', fg: 'white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 900, art_lines: [
      [{ t: 'main ──●──●──●──', fg: 'white' }],
      [{ t: '           └──● ', fg: 'bright_green', bold: true }, { t: 'dev-migration', fg: 'bright_green' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: 'main ──●──●──●──', fg: 'white' }],
      [{ t: '           └──● ', fg: 'bright_green', bold: true }, { t: 'dev-migration', fg: 'bright_green' }],
      [{ t: 'branch do banco em 0,8s — isolado, descartável. ', fg: 'bright_white', bold: true }, { t: 'Zenith DB', fg: 'bright_green', bold: true }],
    ] },
  ]),
  ad('orbitup', 'orbit-ci.example/up', 'cyan', 'wipe', [
    { hold_ms: 600, art_lines: [
      [{ t: '⏵ compose up  ', fg: 'bright_white', bold: true }, { t: '[web ✔]', fg: 'bright_cyan', bold: true }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 600, art_lines: [
      [{ t: '⏵ compose up  ', fg: 'bright_white', bold: true }, { t: '[web ✔] [db ✔] [cache ✔]', fg: 'bright_cyan', bold: true }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '[web ✔] [db ✔] [cache ✔] [worker ✔]', fg: 'bright_cyan', bold: true }],
      [{ t: '◆ Orbit — ', fg: 'bright_white', bold: true }, { t: 'o ambiente inteiro, um comando', fg: 'bright_cyan', bold: true }],
    ] },
  ]),
  ad('vantageapm', 'vantage-metrics.example/apm', 'magenta', 'cut', [
    { hold_ms: 800, art_lines: [
      [{ t: 'trace: ', fg: 'white' }, { t: 'GET /api/user', fg: 'bright_white', bold: true }, { t: '  240ms', fg: 'bright_red', bold: true }],
      [{ t: '└─ ?', fg: 'bright_black' }],
      [{ t: ' ', fg: 'white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 1000, art_lines: [
      [{ t: '├─ DB     ', fg: 'white' }, { t: '▐██▌', fg: 'bright_magenta' }, { t: ' 4ms', fg: 'white' }],
      [{ t: '├─ Cache  ', fg: 'white' }, { t: '▐▌', fg: 'bright_magenta' }, { t: ' 1ms', fg: 'white' }],
      [{ t: '└─ render ', fg: 'white' }, { t: '▐██████████████▌', fg: 'bright_red', bold: true }, { t: ' 231ms ←', fg: 'bright_red', bold: true }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: '├─ DB     ', fg: 'white' }, { t: '▐██▌', fg: 'bright_magenta' }, { t: ' 4ms', fg: 'white' }],
      [{ t: '├─ Cache  ', fg: 'white' }, { t: '▐▌', fg: 'bright_magenta' }, { t: ' 1ms', fg: 'white' }],
      [{ t: '└─ render ', fg: 'white' }, { t: '▐██████████████▌', fg: 'bright_red', bold: true }, { t: ' 231ms ←', fg: 'bright_red', bold: true }],
      [{ t: 'gargalo achado em 0,2s ', fg: 'bright_white', bold: true }, { t: '◉ Vantage APM', fg: 'bright_magenta', bold: true }],
    ] },
  ]),
  ad('tasklanehook', 'tasklane.example/git', 'magenta', 'typewriter', [
    { hold_ms: 1000, art_lines: [
      [{ t: '$ ', fg: 'bright_green', bold: true }, { t: 'git commit -m "fix auth ', fg: 'bright_white' }, { t: '[Fixes TSK-1042]', fg: 'bright_magenta', bold: true }, { t: '"', fg: 'bright_white' }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 800, art_lines: [
      [{ t: 'TSK-1042  ', fg: 'bright_magenta', bold: true }, { t: '──▸  ', fg: 'white' }, { t: '[ Done ✓ ]', fg: 'bright_green', bold: true }],
      [{ t: ' ', fg: 'white' }],
    ] },
    { hold_ms: 3000, art_lines: [
      [{ t: 'TSK-1042  ', fg: 'bright_magenta', bold: true }, { t: '──▸  ', fg: 'white' }, { t: '[ Done ✓ ]', fg: 'bright_green', bold: true }],
      [{ t: '▰ Tasklane — ', fg: 'bright_magenta', bold: true }, { t: 'seus commits fecham as issues', fg: 'bright_white' }],
    ] },
  ]),
];

module.exports = { HYPOTHETICAL_ADS };

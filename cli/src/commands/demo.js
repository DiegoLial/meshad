'use strict';

/**
 * meshad demo — the heart of the product, end to end and for real:
 * a fake agent "thinks" for N seconds while the real pipeline runs
 * (idle_start → signed pack from cache → render after min wait →
 * clear <100ms → idle_end + impression → earnings estimate).
 *
 * Only the agent is simulated. Every network byte is real.
 */

const config = require('../config');
const i18n = require('../i18n');
const { AdCache } = require('../adcache');
const { Telemetry } = require('../telemetry');
const { IdleStateMachine } = require('../fsm');
const { LineRenderer, formatAd } = require('../render');
const { makeEvent, loadWindow, saveWindow, estimateEarningsMicros } = require('../session');
const { c, parseFlags, usd } = require('../util');

const HELP = `
  meshad demo [--wait <seconds>] — simulate an AI agent thinking

  Runs the complete, real ad flow against the API while a fake agent
  "processes" for --wait seconds (default 12). Demo uses a 3s minimum
  wait instead of the production ${8}s so you see the ad sooner.

  Options:
    --wait <s>   how long the fake agent thinks (default 12)
    --help
`;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DEMO_MIN_WAIT_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function demo(_cmd, argv) {
  const { flags } = parseFlags(argv, { wait: 'string', help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  const waitMs = Math.max(1, Math.round(Number(flags.wait || 12) * 1000) || 12000);

  const cfg = config.load();
  i18n.init(cfg);
  const { t } = i18n;
  if (!cfg.anon_id) {
    console.error(`${c.red('error:')} ${t('err.notInitialized')} ${c.bold('meshad init')}`);
    return 1;
  }

  const apiUrl = config.apiUrl(cfg);
  const dir = config.configDir();
  const isTTY = !!process.stdout.isTTY;
  const paused = config.isPaused(cfg);

  const telemetry = new Telemetry({ dir, apiUrl });
  const adcache = new AdCache({ dir, apiUrl });
  const renderer = new LineRenderer(process.stdout);
  const fsm = new IdleStateMachine({
    minWaitMs: DEMO_MIN_WAIT_MS,
    capPerHour: cfg.frequency_cap_h,
    history: loadWindow(),
  });

  console.log('');
  console.log(`  ${c.dim('$')} agent ${c.dim('"refactor the auth module to use the new session store"')}`);

  // ── idle_start: the agent went quiet ────────────────────────────────
  const startedAt = Date.now();
  fsm.idleStart(startedAt);
  telemetry.enqueue(makeEvent(cfg, 'idle_start'));
  telemetry.flushSoon(); // fire-and-forget — never on the render path

  // Pre-fetch the signed pack concurrently; the render path only reads memory.
  let ads = [];
  const prefetch = adcache
    .getAds({ anonId: cfg.anon_id, terminalType: cfg.terminal_type_default })
    .then((a) => (ads = a))
    .catch(() => {});

  // ── spinner ─────────────────────────────────────────────────────────
  let frame = 0;
  let spinnerTimer = null;
  if (isTTY) {
    spinnerTimer = setInterval(() => {
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stdout.write(`\r  ${c.dim(`${SPINNER[frame++ % SPINNER.length]} Thinking... (${secs}s)`)}\x1b[K`);
    }, 80);
  } else {
    console.log(`  ${SPINNER[0]} Thinking...`);
  }

  // ── FSM ticks: display after min wait, only with a verified ad ──────
  let shownAd = null;
  const ticker = setInterval(() => {
    if (paused || shownAd || ads.length === 0) return;
    for (const action of fsm.tick(Date.now())) {
      if (action.type === 'display') {
        shownAd = ads[0]; // one unit per wait, never rotated
        const lines = formatAd(shownAd, process.stdout.columns || 80);
        if (isTTY) {
          renderer.render(lines);
        } else {
          for (const l of lines) console.log(`  ${l}`); // demo without a TTY: plain lines (see README)
        }
      }
    }
  }, 100);

  await sleep(waitMs);
  await prefetch.catch(() => {});

  // ── idle_end: the "response" arrives. Clear FIRST — dev work wins. ──
  const endActions = fsm.idleEnd(Date.now());
  let clearMs = null;
  let impression = null;
  for (const action of endActions) {
    if (action.type === 'clear') {
      const t0 = process.hrtime.bigint();
      renderer.clear(); // synchronous single write — the <100ms invariant
      clearMs = Number(process.hrtime.bigint() - t0) / 1e6;
    } else if (action.type === 'impression') {
      impression = action;
      telemetry.enqueue(makeEvent(cfg, 'impression', { ad_id: shownAd.ad_id, duration_ms: action.displayed_ms }));
    } else if (action.type === 'idle_end') {
      telemetry.enqueue(makeEvent(cfg, 'idle_end', { duration_ms: action.duration_ms }));
    }
  }
  clearInterval(ticker);
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    process.stdout.write('\r\x1b[K');
  }
  saveWindow(fsm.history);

  // ── the fake agent answers ──────────────────────────────────────────
  console.log(`  ${c.green('✓')} Done (${(waitMs / 1000).toFixed(1)}s). Refactored ${c.bold('auth/session.ts')}: swapped the`);
  console.log('    legacy cookie store for the new session store, updated 3 call sites,');
  console.log('    added tests. All 42 tests pass.');
  console.log('');

  // ── deliver telemetry (only now do we await the network) ────────────
  const { sent } = await telemetry.flush();

  // ── honest summary ──────────────────────────────────────────────────
  if (impression && shownAd) {
    const earned = estimateEarningsMicros(shownAd);
    console.log(`  ${c.dim('─'.repeat(60))}`);
    console.log(
      `  ${t('demo.summary', { shown: (impression.displayed_ms / 1000).toFixed(1), clear: clearMs.toFixed(1), sent })}`
    );
    console.log(
      `  ${c.bold(t('demo.earned', { amount: usd(earned) }))} ${c.dim(t('demo.earnedHint', { model: shownAd.pricing_model }))}`
    );
  } else if (paused) {
    console.log(`  ${c.dim(t('demo.paused'))}`);
  } else if (!shownAd) {
    console.log(`  ${c.dim(t('demo.noAd'))}`);
  } else {
    console.log(`  ${c.dim(t('demo.tooShort'))}`);
  }
  console.log('');
  return 0;
};

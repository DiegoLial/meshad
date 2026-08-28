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
const { Telemetry, NullTelemetry } = require('../telemetry');
const { HYPOTHETICAL_ADS } = require('../hypothetical');
const { IdleStateMachine } = require('../fsm');
const { LineRenderer, Animator, buildTimeline, formatAd } = require('../render');
const { makeEvent, loadWindow, saveWindow, estimateEarningsMicros } = require('../session');
const { c, parseFlags, usd } = require('../util');

const HELP = `
  meshad demo [--wait <seconds>] — simulate an AI agent thinking

  Runs the complete, real ad flow against the API while a fake agent
  "processes" for --wait seconds (default 12). Demo uses a 3s minimum
  wait instead of the production ${8}s so you see the ad sooner.

  Options:
    --wait <s>   how long the fake agent thinks (default 12)
    --all        showcase: play EVERY ad in the REAL network pack, one after
                 the other (preview only — nothing is sent, billed or credited)
    --h          hypothetical showcase: LOOP the bundled example pack forever
                 (Ctrl+C stops; offline-safe, nothing sent or billed)
    --hold <s>   seconds each --all ad stays on screen (default: two animation
                 cycles, min 5s, max 12s)
    --help
`;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DEMO_MIN_WAIT_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function demo(_cmd, argv) {
  const { flags } = parseFlags(argv, { wait: 'string', all: 'bool', h: 'bool', hold: 'string', help: 'bool' });
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

  // ── --all: showcase every ad in the pack, back to back ──────────────
  // A preview, not a wait: no fsm, no cap window, no telemetry object at all —
  // nothing leaves the machine, nothing bills, nothing credits.
  if (flags.all || flags.h) {
    // --all previews the REAL network pack (even in dev_mode — you are
    // inspecting what production serves). --h loops the bundled hypothetical
    // pack forever, offline-safe. Both are previews: nothing sent or billed.
    const showcase = new AdCache({ dir, apiUrl });
    const ads = flags.h
      ? HYPOTHETICAL_ADS
      : await showcase.getAds({ anonId: cfg.anon_id, terminalType: cfg.terminal_type_default });
    if (!ads.length) {
      console.log(`  ${c.dim(t('demo.noAdCache'))}`);
      return 0;
    }
    const renderer2 = new LineRenderer(process.stdout);
    const animator2 = new Animator(renderer2);
    process.on('SIGINT', () => {
      animator2.stop();
      process.stdout.write('\n');
      process.exit(0);
    });
    console.log('');
    console.log(`  ${c.yellow(flags.h ? t('demo.hypBanner', { n: ads.length }) : t('demo.allBanner', { n: ads.length }))}`);
    const showOne = async (ad, k) => {
      const label = (ad.render && ad.render.cta) || ad.ad_id;
      const price = `$${(Number(ad.price_micros) / 1e6).toFixed(2)} ${ad.pricing_model}`;
      console.log('');
      console.log(`  ${c.dim(`[${k + 1}/${ads.length}]`)} ${c.bold(label)} ${c.dim(`· ${ad.format} · ${price}`)}`);
      if (isTTY) {
        const timeline = buildTimeline(ad, process.stdout.columns || 80, process.stdout.rows || 24);
        const cycleMs = (timeline.steps || []).reduce((s, st) => s + (st.ms || 0), 0);
        // Two full cycles by default — one is over before the eye settles.
        const holdMs = flags.hold
          ? Math.max(2, Number(flags.hold) || 0) * 1000
          : Math.min(Math.max(5000, cycleMs * 2), 12000);
        animator2.play(timeline);
        await sleep(holdMs);
        animator2.stop();
      } else {
        for (const l of formatAd(ad, process.stdout.columns || 80)) console.log(`  ${l}`);
      }
    };
    if (flags.h) {
      if (!isTTY) { // sem TTY, um passe único evita loop infinito num pipe
        for (let k = 0; k < ads.length; k++) await showOne(ads[k], k);
        return 0;
      }
      for (let k = 0; ; k = (k + 1) % ads.length) await showOne(ads[k], k);
    }
    for (let k = 0; k < ads.length; k++) await showOne(ads[k], k);
    console.log('');
    console.log(`  ${c.dim(t('demo.allDone', { n: ads.length }))}`);
    return 0;
  }

  const telemetry = cfg.dev_mode ? new NullTelemetry() : new Telemetry({ dir, apiUrl });
  const adcache = new AdCache({ dir, apiUrl });
  const renderer = new LineRenderer(process.stdout);
  const animator = new Animator(renderer);
  const fsm = new IdleStateMachine({
    minWaitMs: DEMO_MIN_WAIT_MS,
    capPerHour: cfg.dev_mode ? Infinity : cfg.frequency_cap_h,
    history: cfg.dev_mode ? [] : loadWindow(),
  });

  console.log('');
  if (cfg.dev_mode) console.log(`  ${c.yellow(t('demo.devBanner'))}`);
  console.log(`  ${c.dim('$')} agent ${c.dim('"refactor the auth module to use the new session store"')}`);

  // ── idle_start: the agent went quiet ────────────────────────────────
  const startedAt = Date.now();
  fsm.idleStart(startedAt);
  telemetry.enqueue(makeEvent(cfg, 'idle_start'));
  telemetry.flushSoon(); // fire-and-forget — never on the render path

  // Pre-fetch the signed pack concurrently; the render path only reads memory.
  // dev_mode: the bundled hypothetical pack replaces the network entirely —
  // offline-safe, no real advertiser ever appears inside an experiment.
  let ads = cfg.dev_mode ? HYPOTHETICAL_ADS : [];
  const prefetch = cfg.dev_mode
    ? Promise.resolve()
    : adcache
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
        shownAd = adcache.nextAd(ads) || ads[0]; // one unit per wait, rotating through the ranked pack
        const lines = formatAd(shownAd, process.stdout.columns || 80);
        if (isTTY) {
          animator.play(buildTimeline(shownAd, process.stdout.columns || 80, process.stdout.rows || 24));
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
      animator.stop(); // synchronous single write — the <100ms invariant
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
  if (!cfg.dev_mode) saveWindow(fsm.history); // dev impressions never consume the real cap window

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
    if (cfg.dev_mode) {
      console.log(`  ${c.yellow(t('demo.devEarned'))}`);
    } else {
      console.log(
        `  ${c.bold(t('demo.earned', { amount: usd(earned) }))} ${c.dim(t('demo.earnedHint', { model: shownAd.pricing_model }))}`
      );
    }
  } else if (paused) {
    console.log(`  ${c.dim(t('demo.paused'))}`);
  } else if (!shownAd) {
    // Say WHICH gate blocked the ad — three causes bundled in one string made
    // "why no ad?" the first support question this demo generated.
    const reason = ads.length === 0
      ? 'demo.noAdCache'
      : !fsm.canDisplay(Date.now()) ? 'demo.noAdCap' : 'demo.noAdShort';
    console.log(`  ${c.dim(t(reason, { cap: cfg.frequency_cap_h }))}`);
  } else {
    console.log(`  ${c.dim(t('demo.tooShort'))}`);
  }
  console.log('');
  return 0;
};

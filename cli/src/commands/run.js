'use strict';

/**
 * meshad run -- <cmd> — universal wrapper (strategy C, opt-in).
 *
 * Spawns the command with piped stdout/stderr and forwards every byte
 * untouched. Idle detection is TIMING-ONLY: the detector sees when output
 * happened, never what it said (chunks go straight through to the real
 * stdout/stderr). Silence > 1.5s with the process alive = idle_start;
 * the next byte of output (or exit) = idle_end → clear first, always.
 */

const { spawn } = require('node:child_process');
const config = require('../config');
const { AdCache } = require('../adcache');
const { Telemetry, NullTelemetry } = require('../telemetry');
const i18n = require('../i18n');
const { IdleStateMachine } = require('../fsm');
const { LineRenderer, Animator, buildTimeline } = require('../render');
const { makeEvent, loadWindow, saveWindow } = require('../session');
const { c, parseFlags } = require('../util');

const HELP = `
  meshad run -- <command> [args...] — wrap any agent CLI

  Forwards the command's output untouched and watches only its *timing*:
  after 1.5s of silence the wait starts; if it lasts past your min wait
  (config min_wait_ms, default 8000ms) one signed sponsored line appears
  on the bottom row — and disappears the instant output resumes.

  Example: meshad run -- aider --model gpt-5
`;

const SILENCE_MS = 1500;
const TICK_MS = 100;

module.exports = async function run(_cmd, argv) {
  const { flags } = parseFlags(argv.filter((a) => a === '--help'), { help: 'bool' });
  if (flags.help || argv.length === 0) {
    console.log(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sep = argv.indexOf('--');
  const cmdline = sep >= 0 ? argv.slice(sep + 1) : argv;
  if (cmdline.length === 0) {
    console.error(`${c.red('error:')} no command given — usage: meshad run -- <cmd>`);
    return 2;
  }

  const cfg = config.load();
  if (!cfg.anon_id) {
    console.error(`${c.red('error:')} not initialized — run ${c.bold('meshad init')} first`);
    return 1;
  }

  const dir = config.configDir();
  const apiUrl = config.apiUrl(cfg);
  const paused = config.isPaused(cfg);
  const telemetry = cfg.dev_mode ? new NullTelemetry() : new Telemetry({ dir, apiUrl });
  const adcache = new AdCache({ dir, apiUrl });
  const renderer = new LineRenderer(process.stdout);
  // The animator owns playback; stop() halts any pending frame AND clears, so
  // an animated ad can never outlive the wait it was drawn for.
  const animator = new Animator(renderer);
  const fsm = new IdleStateMachine({
    minWaitMs: cfg.min_wait_ms,
    capPerHour: cfg.dev_mode ? Infinity : cfg.frequency_cap_h,
    history: cfg.dev_mode ? [] : loadWindow(),
  });
  if (cfg.dev_mode) console.error(`  ${c.yellow(i18n.t('demo.devBanner'))}`);

  let ads = [];
  let shownAd = null;
  let lastOutputAt = Date.now();

  // Pre-fetch off the hot path; the render path only ever reads memory.
  adcache
    .getAds({ anonId: cfg.anon_id, terminalType: cfg.terminal_type_default })
    .then((a) => (ads = a))
    .catch(() => {});

  const child = spawn(cmdline[0], cmdline.slice(1), {
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  function endIdle() {
    for (const action of fsm.idleEnd(Date.now())) {
      if (action.type === 'clear') {
        animator.stop(); // FIRST, synchronous — the <100ms invariant
      } else if (action.type === 'impression' && shownAd) {
        telemetry.enqueue(makeEvent(cfg, 'impression', { ad_id: shownAd.ad_id, duration_ms: action.displayed_ms }));
      } else if (action.type === 'idle_end') {
        telemetry.enqueue(makeEvent(cfg, 'idle_end', { duration_ms: action.duration_ms }));
      }
    }
    shownAd = null;
    if (!cfg.dev_mode) saveWindow(fsm.history); // dev impressions never consume the real cap window
    telemetry.flushSoon();
  }

  // Transparent forwarding: bytes pass through untouched; only their
  // arrival time feeds the detector.
  child.stdout.on('data', (chunk) => {
    if (fsm.state !== 'idle') endIdle(); // clear BEFORE the new output lands
    process.stdout.write(chunk);
    lastOutputAt = Date.now();
  });
  child.stderr.on('data', (chunk) => {
    if (fsm.state !== 'idle') endIdle();
    process.stderr.write(chunk);
    lastOutputAt = Date.now();
  });

  const ticker = setInterval(() => {
    const now = Date.now();
    if (fsm.state === 'idle' && now - lastOutputAt >= SILENCE_MS && child.exitCode === null) {
      fsm.idleStart(now - SILENCE_MS); // the wait began when the output stopped
      telemetry.enqueue(makeEvent(cfg, 'idle_start'));
      telemetry.flushSoon();
    }
    if (!paused && !shownAd && ads.length > 0) {
      for (const action of fsm.tick(now)) {
        if (action.type === 'display') {
          shownAd = adcache.nextAd(ads) || ads[0]; // one unit per wait, rotating through the ranked pack
          // Static creatives yield a single-step timeline, so this is the same
          // single synchronous write they always were.
          animator.play(buildTimeline(shownAd, process.stdout.columns || 80, process.stdout.rows || 24));
        }
      }
    }
  }, TICK_MS);

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code == null ? 1 : code));
    child.on('error', (e) => {
      console.error(`${c.red('error:')} ${e.message}`);
      resolve(127);
    });
  });

  clearInterval(ticker);
  if (fsm.state !== 'idle') endIdle();
  await telemetry.flush().catch(() => {});
  return exitCode;
};

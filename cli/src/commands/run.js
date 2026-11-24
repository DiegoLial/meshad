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

const { spawn, spawnSync } = require('node:child_process');
const config = require('../config');
const { AdCache } = require('../adcache');
const { Telemetry, NullTelemetry } = require('../telemetry');
const { HYPOTHETICAL_ADS } = require('../hypothetical');
const i18n = require('../i18n');
const { IdleStateMachine } = require('../fsm');
const { LineRenderer, Animator, buildTimeline } = require('../render');
const { makeEvent, loadWindow, saveWindow } = require('../session');
const { c } = require('../util');
const { GAME_IDS } = require('../creative');
const bridge = require('../play/bridge');
const tmux = require('../play/tmux');
const { isVisible, VisibilityTracker } = require('../play/visibility');

const HELP = `
  meshad run -- <command> [args...] — wrap any agent CLI

  Forwards the command's output untouched and watches only its *timing*:
  after 1.5s of silence the wait starts; if it lasts past your min wait
  (config min_wait_ms, default 8000ms) one signed sponsored line appears
  on the bottom row — and disappears the instant output resumes.

  Options (before the "--"):
    --play    while the agent thinks, open \`meshad play\` in a tmux split (needs
              $TMUX) instead of drawing the one-line ad. Outside tmux it only
              writes the wait state and tells you to open \`meshad play\` in
              another pane. Your agent's stdin is never touched.
    --help    show this help

  Example: meshad run -- aider --model gpt-5
           meshad run --play -- claude
`;

const SILENCE_MS = 1500;
const TICK_MS = 100;
const VISIBILITY_SAMPLE_MS = 500; // how often the split's visibility is checked while a unit is open

const RUN_FLAGS = ['--play', '--help'];

/**
 * Parse `meshad run [--play] [--help] [--] <cmd> [args...]`.
 * Everything AFTER the first `--` belongs to the wrapped command, verbatim
 * (so `meshad run -- aider --help` runs aider's help, not ours). Before it,
 * only our own flags are legal. Without any `--` the leading flags are still
 * ours and the rest is the command (the long-standing lenient form).
 * @returns {{help:boolean, play:boolean, cmdline:string[], error:string|null}}
 */
function parseRunArgs(argv) {
  const sep = argv.indexOf('--');
  const flagsEnd = sep >= 0 ? sep : (() => {
    let i = 0;
    while (i < argv.length && RUN_FLAGS.includes(argv[i])) i++;
    return i;
  })();
  const own = argv.slice(0, flagsEnd);
  const cmdline = sep >= 0 ? argv.slice(sep + 1) : argv.slice(flagsEnd);
  const bad = own.find((a) => !RUN_FLAGS.includes(a));
  return {
    help: own.includes('--help'),
    play: own.includes('--play'),
    cmdline,
    error: bad === undefined ? null : bad,
  };
}

module.exports = async function run(_cmd, argv) {
  if (argv.length === 0) {
    console.log(HELP);
    return 2;
  }
  const parsed = parseRunArgs(argv);
  if (parsed.error !== null) {
    console.error(`${c.red('error:')} ${i18n.t('run.unknownOption', { opt: parsed.error })}`);
    return 2;
  }
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  const { cmdline, play } = parsed;
  if (cmdline.length === 0) {
    console.error(`${c.red('error:')} no command given — usage: meshad run -- <cmd>`);
    return 2;
  }
  if (cmdline[0].startsWith('-')) {
    // "meshad run --claude" is a mistyped separator, not a flag we own.
    const guess = cmdline[0].replace(/^-+/, '');
    console.error(`${c.red('error:')} "${cmdline[0]}" looks like a mistyped separator — the command goes AFTER "--":`);
    console.error(`  meshad run -- ${guess}${cmdline.length > 1 ? ' ' + cmdline.slice(1).join(' ') : ''}`);
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

  let ads = cfg.dev_mode ? HYPOTHETICAL_ADS : [];
  let shownAd = null;
  let lastOutputAt = Date.now();

  // --play: the wait state goes to a plain file `meshad play` watches. It must
  // never be able to break the wrap, so every bridge touch is best-effort.
  const inTmux = play && tmux.available();
  let playPane = null; // pane id of the split we opened, if any
  let splitHandled = false; // one unit per wait: decide the split once per wait
  let lastBeatAt = 0;
  let visibility = null; // VisibilityTracker for the open unit (only while a sponsored split is displayed)
  let lastSampleAt = 0;
  const beat = (state, now = Date.now()) => {
    if (!play) return;
    try { bridge.writeState(dir, state, now); } catch { /* best effort */ }
    lastBeatAt = now;
  };
  if (play) {
    if (!inTmux) console.error(`  ${c.yellow(i18n.t('run.playNoTmux'))}`);
    beat('idle'); // the agent starts out busy
  }

  // Pre-fetch off the hot path; the render path only ever reads memory.
  if (!cfg.dev_mode) adcache
    .getAds({ anonId: cfg.anon_id, terminalType: cfg.terminal_type_default })
    .then((a) => (ads = a))
    .catch(() => {});

  // Interactive agent CLIs (Claude Code, aider) probe their stdout: a plain
  // pipe flips them into non-interactive mode ("input must be provided…").
  // Wrapping the child in a PTY via util-linux `script` keeps it fully
  // interactive while we still observe the byte timing on our pipe. Zero new
  // dependencies; falls back to a direct pipe when `script` is unavailable.
  const shq = (s) => (/^[A-Za-z0-9_\/:=.,@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const hasScript =
    process.stdout.isTTY &&
    process.platform !== 'win32' &&
    spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;
  const child = hasScript
    ? spawn('script', ['-qefc', cmdline.map(shq).join(' '), '/dev/null'], { stdio: ['inherit', 'pipe', 'pipe'] })
    : spawn(cmdline[0], cmdline.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });

  function endIdle() {
    // A sponsored split bills what was really visible, not the time since it opened.
    const visibleMs = visibility ? visibility.billableMs() : undefined;
    visibility = null;
    for (const action of fsm.idleEnd(Date.now(), visibleMs)) {
      if (action.type === 'clear') {
        animator.stop(); // FIRST, synchronous — the <100ms invariant
      } else if (action.type === 'impression' && shownAd) {
        telemetry.enqueue(makeEvent(cfg, 'impression', { ad_id: shownAd.ad_id, duration_ms: action.displayed_ms }));
      } else if (action.type === 'idle_end') {
        telemetry.enqueue(makeEvent(cfg, 'idle_end', { duration_ms: action.duration_ms }));
      }
    }
    shownAd = null;
    splitHandled = false;
    beat('idle');
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

  /**
   * --play: once the wait passes min_wait, hand it to the game instead of the
   * footer ad. Exactly one unit per wait. A sponsored impression exists only
   * when a NEW split was opened with a signed game ad's skin (the fsm then
   * counts it like any display: ≥2s on screen, frequency cap, telemetry).
   * No tmux / no game ad / split refused → no unit, nothing billed.
   */
  function playUnit(now) {
    if (splitHandled) return;
    splitHandled = true;
    if (!inTmux) return; // nowhere to open a pane; the up-front notice already told the user
    if (playPane && tmux.paneAlive(playPane)) return; // already open: it resumes on its own
    const gameAd = paused ? null : adcache.nextAd(
      ads.filter((a) => a && a.format === 'ascii_panel' && a.render && GAME_IDS.includes(a.render.game)),
    );
    const pane = tmux.openSplit({ dir, game: gameAd ? gameAd.render.game : null, adId: gameAd && gameAd.ad_id });
    if (!pane) return;
    playPane = pane;
    if (!gameAd || !fsm.canDisplay(now)) return; // free-play split: no unit to bill
    for (const action of fsm.tick(now)) {
      if (action.type === 'display') {
        shownAd = gameAd;
        visibility = new VisibilityTracker();
        lastSampleAt = 0;
      }
    }
  }

  /** Sample whether the open split is really on screen (play drawing + tmux window active). */
  function sampleVisibility(now) {
    if (!visibility || !playPane || now - lastSampleAt < VISIBILITY_SAMPLE_MS) return;
    lastSampleAt = now;
    let visible = false;
    try {
      visible = isVisible({ render: bridge.readRender(dir), info: tmux.paneInfo(playPane), now, pane: playPane });
    } catch { /* unreadable → not visible */ }
    visibility.sample(now, visible);
  }

  const ticker = setInterval(() => {
    const now = Date.now();
    if (fsm.state === 'idle' && now - lastOutputAt >= SILENCE_MS && child.exitCode === null) {
      fsm.idleStart(now - SILENCE_MS); // the wait began when the output stopped
      telemetry.enqueue(makeEvent(cfg, 'idle_start'));
      telemetry.flushSoon();
      beat('waiting', now);
    } else if (fsm.state !== 'idle' && now - lastBeatAt >= bridge.HEARTBEAT_MS) {
      beat('waiting', now); // heartbeat: tells play the writer is alive
    }
    if (play) {
      if (fsm.state === 'waiting' && now - fsm.idleStartAt >= fsm.minWaitMs) playUnit(now);
      sampleVisibility(now);
      return;
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
  if (play) bridge.clearState(dir); // a later `meshad play` is plain free-play
  await telemetry.flush().catch(() => {});
  return exitCode;
};

module.exports.parseRunArgs = parseRunArgs;

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
const { LineRenderer, Animator, buildTimeline, MAX_ROWS_ART } = require('../render');
const { makeEvent, loadWindow, saveWindow } = require('../session');
const { c } = require('../util');
const { GAME_IDS } = require('../creative');
const bridge = require('../play/bridge');
const tmux = require('../play/tmux');
const { isVisible, VisibilityTracker } = require('../play/visibility');
const interests = require('../interests');
const { NewsCache } = require('../news');
const { formatNews } = require('../news-render');
const { maybeRunOnboarding } = require('../onboarding');

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
    --news    show 1-2 local-interest headlines next to the ad (or alone when no ad
              shows). Needs topics declared with \`meshad interests add\`; also on
              whenever \`meshad interests enable\` is set. Never billed, never sponsored.
    --help    show this help

  Example: meshad run -- aider --model gpt-5
           meshad run --play -- claude
`;

const SILENCE_MS = 1500;
const TICK_MS = 100;
const VISIBILITY_SAMPLE_MS = 500; // how often the split's visibility is checked while a unit is open

const RUN_FLAGS = ['--play', '--news', '--help'];

/**
 * Parse `meshad run [--play] [--news] [--help] [--] <cmd> [args...]`.
 * Everything AFTER the first `--` belongs to the wrapped command, verbatim
 * (so `meshad run -- aider --help` runs aider's help, not ours). Before it,
 * only our own flags are legal. Without any `--` the leading flags are still
 * ours and the rest is the command (the long-standing lenient form).
 * @returns {{help:boolean, play:boolean, news:boolean, cmdline:string[], error:string|null}}
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
    news: own.includes('--news'),
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
  const { cmdline, play, news } = parsed;
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

  let cfg = config.load();
  if (!cfg.anon_id) {
    console.error(`${c.red('error:')} not initialized — run ${c.bold('meshad init')} first`);
    return 1;
  }

  const dir = config.configDir();
  // First run on a real terminal: ask once (games? news?) BEFORE the child is
  // spawned, so nothing else is reading stdin. Reload so the answers apply now.
  if (process.stdin.isTTY && process.stdout.isTTY && !cfg.onboarding_done) {
    try { await maybeRunOnboarding({ dir, cfg }); } catch { /* onboarding never blocks the wrap */ }
    cfg = config.load();
  }
  const apiUrl = config.apiUrl(cfg);
  const paused = config.isPaused(cfg);
  const telemetry = cfg.dev_mode ? new NullTelemetry() : new Telemetry({ dir, apiUrl });
  const adcache = new AdCache({ dir, apiUrl });
  // Local-only interests (never uploaded). News is its own channel: it never
  // goes through the fsm, is never billed and never emits an impression.
  const interestsState = interests.loadInterests(dir);
  // Games can be enabled once in config (onboarding / menu), no --play needed.
  // NOTE: there is deliberately NO bare "J" hotkey here. The child runs with
  // stdio ['inherit', 'pipe', 'pipe'] (usually under `script`), so it reads the
  // real stdin itself; if run.js also read process.stdin it would steal or
  // swallow the agent's keystrokes — a privacy-invariant violation. The hotkey
  // is tmux's own prefix binding (Ctrl+B J), handled by tmux, never by us.
  const configPlay = cfg.play_mode === 'yes';
  const effectivePlay = play || configPlay;
  const inTmux = effectivePlay && tmux.available();
  if (news && !effectivePlay && (!interestsState.consented_at || interestsState.topics.length === 0)) {
    console.error(`  ${c.yellow(i18n.t('run.newsNotConfigured', { cmd: 'meshad interests add <topic>' }))}`);
  }
  const newsActive = (!effectivePlay || !inTmux) && !paused && interests.isNewsActive(interestsState, { flagNews: news });
  const newscache = new NewsCache({ dir, apiUrl });
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
  let shownSurface = 'footer'; // where shownAd is on screen: the one-line footer, or the sponsored game split
  let shownNews = false; // standalone headlines on screen (no ad, nothing billed)
  let newsFeed = [];
  let lastOutputAt = Date.now();

  // --play: the wait state goes to a plain file `meshad play` watches. It must
  // never be able to break the wrap, so every bridge touch is best-effort.
  let playPane = null; // pane id of the split we opened, if any
  let splitHandled = false; // one unit per wait: decide the split once per wait
  let lastBeatAt = 0;
  let visibility = null; // VisibilityTracker for the open unit (only while a sponsored split is displayed)
  let lastSampleAt = 0;
  let lastAdoptAt = 0;
  let baselinePane = null; // pane already rendering when this wait began: not opened DURING the wait, so not adopted
  let shownHint = false; // discreet one-line hint on screen (never billed)
  const beat = (state, now = Date.now()) => {
    if (!effectivePlay) return;
    try { bridge.writeState(dir, state, now); } catch { /* best effort */ }
    lastBeatAt = now;
  };
  let keyHandle = null;
  const unbind = () => { const h = keyHandle; keyHandle = null; tmux.unbindPlayKey(h); };
  if (effectivePlay) {
    if (!inTmux) {
      console.error(`  ${c.yellow(i18n.t(play ? 'run.playNoTmux' : 'run.playNoTmuxConfig'))}`);
    } else {
      keyHandle = tmux.bindPlayKey({ dir });
      process.once('exit', unbind);
    }
    beat('idle'); // the agent starts out busy
  }

  // Pre-fetch off the hot path; the render path only ever reads memory.
  if (!cfg.dev_mode) adcache
    .getAds({ anonId: cfg.anon_id, terminalType: cfg.terminal_type_default })
    .then((a) => (ads = a))
    .catch(() => {});

  if (newsActive) newscache
    .getFeed()
    .then((f) => (newsFeed = f))
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
    // Standalone headlines never move the fsm out of 'waiting', so no 'clear'
    // action will come: wipe them here, synchronously, before anything else.
    if (shownNews || shownHint) animator.stop();
    shownNews = false;
    shownHint = false;
    for (const action of fsm.idleEnd(Date.now(), visibleMs)) {
      if (action.type === 'clear') {
        animator.stop(); // FIRST, synchronous — the <100ms invariant
      } else if (action.type === 'impression' && shownAd) {
        telemetry.enqueue(makeEvent(cfg, 'impression', { ad_id: shownAd.ad_id, duration_ms: action.displayed_ms, surface: shownSurface }));
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
        shownSurface = 'game';
        visibility = new VisibilityTracker();
        lastSampleAt = 0;
      }
    }
  }

  function drawHint(key) {
    shownHint = true;
    const cols = process.stdout.columns || 80;
    const text = i18n.t(key);
    animator.play({ steps: [{ lines: [c.dim(text.length > cols - 1 ? text.slice(0, cols - 1) : text)], ms: 0 }], loop: false });
  }

  /** The user may have opened the pane themselves (Ctrl+B J): adopt it instead of opening a duplicate. */
  function adoptOpenedPane(now) {
    if (splitHandled || now - lastAdoptAt < VISIBILITY_SAMPLE_MS) return;
    lastAdoptAt = now;
    let render = null;
    try { render = bridge.readRender(dir); } catch { /* unreadable → none */ }
    if (render && render.pane && render.pane !== baselinePane && tmux.paneAlive(render.pane)) {
      playPane = render.pane;
      splitHandled = true; // free-play pane the user opened: nothing to bill
      animator.stop();
      shownHint = false;
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
      if (inTmux) {
        try { const r0 = bridge.readRender(dir); baselinePane = r0 && r0.pane; } catch { baselinePane = null; }
        lastAdoptAt = now;
      }
    } else if (fsm.state !== 'idle' && now - lastBeatAt >= bridge.HEARTBEAT_MS) {
      beat('waiting', now); // heartbeat: tells play the writer is alive
    }
    if (inTmux) {
      if (fsm.state === 'waiting') {
        if (now - fsm.idleStartAt < fsm.minWaitMs) {
          adoptOpenedPane(now);
          if (!splitHandled && !shownHint) drawHint('run.hintPressJ');
        } else {
          adoptOpenedPane(now);
          if (shownHint) { animator.stop(); shownHint = false; } // clear BEFORE the split opens
          playUnit(now);
        }
      }
      sampleVisibility(now);
      return;
    }
    // Outside tmux, explicit --play never bills a footer ad (nothing to bill without a split).
    if (!play && !paused && !shownAd && ads.length > 0) {
      for (const action of fsm.tick(now)) {
        if (action.type === 'display') {
          shownAd = adcache.nextAd(ads) || ads[0]; // one unit per wait, rotating through the ranked pack
          shownSurface = 'footer';
          // Static creatives yield a single-step timeline, so this is the same
          // single synchronous write they always were.
          const cols = process.stdout.columns || 80;
          const rows = process.stdout.rows || 24;
          const timeline = buildTimeline(shownAd, cols, rows);
          shownNews = false; // the ad takes over the zone
          if (newsActive && newsFeed.length > 0) {
            const newsLines = formatNews(newscache.nextHeadlines(newsFeed, interestsState.topics, 2), cols);
            // Headlines ride along only if they fit WITHOUT touching the ad's own rows.
            const tallest = Math.max(...timeline.steps.map((st) => st.lines.length));
            if (newsLines.length > 0 && tallest + newsLines.length <= Math.min(rows - 1, MAX_ROWS_ART + 2)) {
              for (const st of timeline.steps) st.lines = [...st.lines, ...newsLines];
            }
          }
          animator.play(timeline);
        }
      }
    }
    if (
      newsActive && !paused && !shownAd && !shownNews && newsFeed.length > 0 &&
      fsm.state === 'waiting' && now - fsm.idleStartAt >= fsm.minWaitMs
    ) {
      // No ad this wait (none cached, or the frequency cap): headlines alone.
      // Deliberately outside the fsm — no tick, no shownAd, no impression.
      const cols = process.stdout.columns || 80;
      const newsLines = formatNews(newscache.nextHeadlines(newsFeed, interestsState.topics, 2), cols, { standalone: true });
      shownNews = true; // one attempt per wait, even if nothing fit
      if (newsLines.length > 0) animator.play({ steps: [{ lines: newsLines, ms: 0 }], loop: false });
      else if (effectivePlay && !shownHint) drawHint('run.playFallbackHint');
    } else if (
      effectivePlay && !shownAd && !shownNews && !shownHint &&
      fsm.state === 'waiting' && now - fsm.idleStartAt >= fsm.minWaitMs &&
      (play || paused || ads.length === 0 || !fsm.canDisplay(now)) &&
      !(newsActive && newsFeed.length > 0)
    ) {
      drawHint('run.playFallbackHint'); // no ad / no headlines this wait: just the discreet pointer
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
  unbind();
  if (effectivePlay) bridge.clearState(dir); // a later `meshad play` is plain free-play
  await telemetry.flush().catch(() => {});
  return exitCode;
};

module.exports.parseRunArgs = parseRunArgs;

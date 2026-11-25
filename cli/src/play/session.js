'use strict';

/**
 * PlaySession — everything `meshad play` does except touching the terminal.
 * Keys in, text lines out, state file polled through the bridge. The TTY shell
 * (play/ui.js) is a thin loop around this, so pause/resume, input handling and
 * rendering are all testable without a PTY.
 *
 * Keys are normalized strings: ' ' · 'enter' · 'backspace' · 'esc' · 'ctrl-c' ·
 * 'up' · 'down' · 'left' · 'right' · or one lowercase letter / digit / '-' / '='.
 *
 * Runner and termo are driven inline below; snake, flappy, blocks, slide and chess
 * go through the controllers in play/arcade.js (same freeze/override/streak/share
 * handling, each at its own engine tick rate — see `tickMs`).
 */

const bridge = require('./bridge');
const runner = require('./runner');
const termo = require('./termo');
const { seedFor, utcDate } = require('./rng');
const streaks = require('./streak');
const term = require('./term');
const views = require('./views');
const arcadeViews = require('./views-arcade');
const arcade = require('./arcade');
const chess = require('./chess');
const cards = require('./cards');
const i18n = require('../i18n');
const { sanitizeAnsiLine } = require('../render');

const GAMES = ['runner', 'termo', ...arcade.ARCADE];
const GAME_CHIP = {
  runner: '▲ RUNNER', termo: '▦ TERMO', snake: '■ SNAKE', flappy: '≈ FLAPPY', blocks: '▤ BLOCKS', slide: '◫ SLIDE', chess: '♞ MATE',
};
const MENU_KEYS = Object.fromEntries(GAMES.map((g, i) => [String(i + 1), g]));

class PlaySession {
  /**
   * @param {object} o
   * @param {string|null} o.game       one of GAMES, or null (menu)
   * @param {string} o.dir             config dir (bridge location)
   * @param {string[]} [o.skinLines]   verified sponsor banner, or []
   * @param {string} [o.skinAccent]    palette colour derived from the verified ad's signed `render.color`, or null
   * @param {() => number} [o.now]
   * @param {object} [o.style]         term.makeStyle(...); default = detected from this process (NO_COLOR, TTY, TERM)
   */
  constructor({ game = null, dir, skinLines = [], skinAccent = null, now = Date.now, style = term.autoStyle() }) {
    this.dir = dir;
    this.skinLines = skinLines;
    this.skinAccent = skinAccent;
    this.now = now;
    this.style = style;
    this.stats = streaks.load(dir); // local-only streaks / bests (play/streak.js)
    this.waitSince = null; // when this pane first saw the agent start thinking
    this.newBest = false;
    this.done = false;
    this.override = false; // player chose to keep playing while the agent answers
    this.mode = 'free';
    this.paused = false;
    this.game = null;
    this.g = null; // arcade controller (snake…chess) when one is the current game
    this.finished = false; // an arcade game's streak/share/result were recorded
    this.shareText = null; // set when a game finishes — printed after leaving the alt screen
    this.result = null; // {game,date,score,log} of a finished, scoreable game — what a leaderboard replay needs
    if (game) this.start(game);
    this.poll();
  }

  start(game) {
    this.game = game;
    this.date = utcDate(this.now());
    this.paused = false;
    this.g = null;
    this.finished = false;
    this.newBest = false;
    this.shareText = null;
    this.result = null;
    if (arcade.ARCADE.includes(game)) {
      this.g = arcade.create(game, this.date);
    } else if (game === 'runner') {
      this.run = runner.create(seedFor(this.date, 'runner'));
      this.started = false;
      this.pendingJump = false;
      this.jumpLog = []; // ticks at which a jump was requested: with the seed, the whole replay
    } else {
      this.tm = termo.create(this.date);
      this.buffer = '';
      this.notice = '';
    }
  }

  /** Re-read the bridge. Call every ~250ms. A mode change drops the free-play override. */
  poll() {
    const mode = bridge.modeOf(bridge.readState(this.dir), this.now());
    if (mode !== this.mode) {
      this.mode = mode;
      this.override = false;
      this.waitSince = mode === 'waiting' ? this.now() : null;
    }
    return this.gate;
  }

  /**
   * How long the agent has been thinking, as seen by this pane. The bridge `ts` is a
   * heartbeat (rewritten every 5s), so the start of the wait is the moment play saw
   * the mode flip. Display-only: it never reaches an engine or the input log.
   */
  get waitMs() {
    return this.mode === 'waiting' && this.waitSince !== null ? Math.max(0, this.now() - this.waitSince) : 0;
  }

  /** 'run' | 'frozen' */
  get gate() {
    return this.override ? 'run' : this.mode === 'idle' ? 'frozen' : 'run';
  }

  /** Milliseconds per engine tick of the current game (the TTY loop re-reads this, so it follows game switches). */
  get tickMs() {
    return this.g ? this.g.tickMs : runner.TICK_MS;
  }

  /** One fixed engine tick (`tickMs`). No-op unless a real-time game is live. */
  tick() {
    if (this.g) {
      if (this.g.realtime && this.gate !== 'frozen' && !this.finished) { this.g.tick(); this.checkFinish(); }
      return;
    }
    if (this.game !== 'runner' || !this.started || this.paused || !this.run.alive || this.gate === 'frozen') return;
    if (this.pendingJump) this.jumpLog.push(this.run.tick);
    runner.step(this.run, this.pendingJump);
    this.pendingJump = false;
    if (this.run.alive && this.run.tick >= runner.MAX_TICKS) this.run.alive = false; // run cap, same as the server replay
    if (!this.run.alive) this.finishRunner();
  }

  /** Persist a finished game's streak/best (local file) and remember if it set a new best. */
  recordResult(game, result) {
    const prevBest = this.stats[game].best;
    this.stats[game] = streaks.record(this.dir, game, this.date, result);
    this.newBest = result.score > 0 && result.score > prevBest;
  }

  finishRunner() {
    this.recordResult('runner', { score: this.run.score, won: true });
    this.shareText = runner.shareString(this.date, this.run.score);
    if (this.run.score > 0) this.result = { game: 'runner', date: this.date, score: this.run.score, log: this.jumpLog.slice() };
  }

  /** First time an arcade game is over: record the streak/best, keep the share string, expose the replayable result. */
  checkFinish() {
    const g = this.g;
    if (!g || this.finished || !g.over) return;
    this.finished = true;
    this.recordResult(g.id, { score: g.score, won: g.won });
    this.shareText = g.shareText();
    const r = g.result();
    if (r) this.result = { game: g.id, date: this.date, score: r.score, log: r.log };
  }

  key(k) {
    if (k === 'ctrl-c') { this.done = true; return; }
    if (this.game === null) return this.menuKey(k);
    if (k === 'esc' || (this.game === 'runner' && k === 'q')) {
      if (this.g && this.g.id === 'slide') { this.g.end(); this.checkFinish(); } // Slide has no natural end: Esc banks the score
      this.done = true;
      return;
    }

    // Frozen: the only live key is Space → keep playing (free-play).
    if (this.gate === 'frozen') {
      if (k === ' ') this.override = true;
      return;
    }
    if (this.g) return this.arcadeKey(k);
    return this.game === 'runner' ? this.runnerKey(k) : this.termoKey(k);
  }

  menuKey(k) {
    if (k === 'esc') this.done = true;
    else if (MENU_KEYS[k]) this.start(MENU_KEYS[k]);
  }

  arcadeKey(k) {
    if (k === 'r' && this.g.id !== 'chess') { this.start(this.g.id); return; } // chess types letters; its puzzle is the day's
    this.g.key(k);
    this.checkFinish();
  }

  runnerKey(k) {
    if (k === 'p' && this.started && this.run.alive) { this.paused = !this.paused; return; }
    if (k === 'r') { this.start('runner'); return; }
    if (k === ' ') {
      if (!this.started) this.started = true;
      else if (!this.paused) this.pendingJump = true;
    }
  }

  termoKey(k) {
    if (this.tm.over) return;
    this.notice = '';
    if (k === 'backspace') this.buffer = this.buffer.slice(0, -1);
    else if (k === 'enter') {
      if (this.buffer.length < termo.WORD_LEN) { this.notice = i18n.t('play.termo.short'); return; }
      termo.guess(this.tm, this.buffer);
      this.buffer = '';
      if (this.tm.over) {
        this.recordResult('termo', { score: termo.score(this.tm), won: this.tm.won });
        this.shareText = termo.shareString(this.tm);
        if (this.tm.won) this.result = { game: 'termo', date: this.date, score: termo.score(this.tm), log: this.tm.guesses.slice() };
      }
    } else if (/^[a-z]$/.test(k) && this.buffer.length < termo.WORD_LEN) this.buffer += k;
  }

  /** Coloured end-of-game card (plain emoji/ASCII at NO_COLOR). [] while a game is still going. */
  shareCardLines() {
    const over = this.g ? this.finished : this.game === 'runner' ? this.started && !this.run.alive : this.game === 'termo' && this.tm.over;
    if (!over) return [];
    const state = this.g ? this.g.s : this.game === 'runner' ? this.run : this.tm;
    return cards.shareCard({
      style: this.style, game: this.game, date: this.date, state, share: this.g ? this.shareText : '', score: this.g ? this.g.score : 0,
      streak: streaks.liveStreak(this.stats[this.game], this.date), best: this.stats[this.game].best, newBest: this.newBest, t: i18n.t,
    });
  }

  /** Score shown in the status bar: current run / guesses so far. */
  barScore() {
    if (this.g) return this.g.barScore();
    if (this.game === 'runner') return `${this.run.score}m`;
    return this.tm.over ? `${termo.score(this.tm)}` : `${this.tm.guesses.length}/${termo.MAX_GUESSES}`;
  }

  /** Lines to draw (each already styled, none wider than `cols`); the last one is the status bar. */
  render(cols = 80, rows = 24) {
    const { style } = this;
    const { t } = i18n;
    const out = [];
    if (this.skinLines.length) out.push(...this.skinLines, '');
    if (this.game === null) {
      out.push(style.gradient('MeshAd Play', 'cyan', 'magenta', { bold: true }), '', t('play.menu'));
      return out.slice(0, Math.max(1, rows - 1));
    }
    const accent = this.skinAccent || 'cyan';
    const frozen = this.gate === 'frozen';
    out.push(`${style.paint(` ${GAME_CHIP[this.game]} `, { fg: 'night', bg: accent, bold: true })} ${style.paint(this.date, { fg: 'mute' })}  ${style.paint(this.statusLine(), { fg: this.mode === 'idle' ? 'magenta' : 'mute' })}`);
    out.push(this.messageLine()); // '' for runner/termo (their overlays live inside the board)
    const bodyRows = rows - 1 - out.length - 2;
    const heat = term.pulseFor(this.waitMs);
    if (frozen) {
      out.push(...cards.freezeCard({
        style, cols, rows: bodyRows, game: t(`play.title.${this.game}`), score: this.barScore(),
        best: this.bestNow(), streak: streaks.liveStreak(this.stats[this.game], this.date), t,
      }));
    } else {
      out.push(...(this.g ? this.renderArcade(cols, rows, heat) : this.game === 'runner' ? this.renderRunner(cols, heat) : this.renderTermo(rows)));
      const card = this.shareCardLines();
      if (card.length) out.push('', ...card);
      const hint = style.paint(t(`play.keys.${this.game}`), { fg: 'mute' });
      const room = rows - 1 - out.length;
      if (room >= 2) out.push('', hint); // tall boards (blocks) give up the blank line before the hint
      else if (room === 1) out.push(hint);
    }
    const body = out.slice(0, Math.max(1, rows - 1));
    while (body.length < rows - 1) body.push('');
    body.push(term.statusBar({
      style, cols, game: GAME_CHIP[this.game], score: this.barScore(), best: this.bestNow(),
      streak: streaks.liveStreak(this.stats[this.game], this.date),
      state: this.override && this.mode === 'idle' ? 'free' : this.mode,
      stateLabel: t(`play.bar.${this.override && this.mode === 'idle' ? 'free' : this.mode}`),
      labels: { score: t(this.game === 'termo' ? 'play.bar.guesses' : 'play.bar.score'), best: t('play.bar.best') },
      waitMs: this.waitMs,
    }));
    return body.map((l) => sanitizeAnsiLine(l, cols - 1).text); // never wider than the pane (a wrapped row would smear the diff)
  }

  /** Personal best including the game in progress (termo's score only exists at the end). */
  bestNow() {
    const b = this.stats[this.game].best;
    if (this.g) return Math.max(b, this.g.score);
    return this.game === 'runner' ? Math.max(b, this.run.score) : b;
  }

  /** The line under the header: start prompt, pause, game over, or (chess) the answer to the last move. */
  messageLine() {
    const g = this.g;
    if (!g) return '';
    const { style } = this;
    const { t } = i18n;
    if (g.id === 'chess') return this.chessMessage();
    if (!g.started) return style.paint(t(g.id === 'snake' ? 'play.snake.start' : 'play.start'), { fg: 'amber', bold: true });
    if (g.paused) return style.paint(t('play.paused'), { fg: 'amber', bold: true });
    if (g.over) return style.paint(t('play.over', { score: g.score }), { fg: 'amber', bold: true });
    if (g.id === 'slide' && g.blocked) return style.paint(t('play.slide.blocked'), { fg: 'mute' });
    return '';
  }

  chessMessage() {
    const { style } = this;
    const { t } = i18n;
    const g = this.g;
    const n = g.notice;
    if (!n) {
      if (g.over) return '';
      return style.paint(t('play.chess.prompt', { n: g.s.mateIn, side: t(g.side === 'w' ? 'play.chess.white' : 'play.chess.black') }), { fg: 'mute' });
    }
    switch (n.kind) {
      case 'solved': return style.paint(t('play.chess.solved', { score: g.score, max: chess.MAX_SCORE }), { fg: 'lime', bold: true });
      case 'failed': return style.paint(t('play.chess.failed', { move: g.s.solution[g.s.idx] || '' }), { fg: 'amber', bold: true });
      case 'correct': return style.paint(t('play.chess.correct', { move: n.move }) + (n.reply ? ` ${t('play.chess.reply', { reply: n.reply })}` : ''), { fg: 'lime' });
      case 'mistake': return style.paint(t('play.chess.mistake', { n: g.lives }), { fg: 'amber', bold: true });
      case 'illegal': return style.paint(t('play.chess.illegal'), { fg: 'red' });
      default: return style.paint(t('play.chess.unparsable'), { fg: 'amber' });
    }
  }

  renderArcade(cols, rows, heat) {
    const o = { style: this.style, cols, rows, pulse: this.mode === 'waiting' ? heat : term.pulseFor(0), t: i18n.t };
    const view = { snake: arcadeViews.snakeView, flappy: arcadeViews.flappyView, blocks: arcadeViews.blocksView, slide: arcadeViews.slideView, chess: arcadeViews.chessView }[this.g.id];
    return view(this.g, o);
  }

  statusLine() {
    if (this.override && this.mode === 'idle') return i18n.t('play.mode.override');
    if (this.mode === 'waiting') return i18n.t('play.mode.waiting');
    if (this.mode === 'idle') return i18n.t('play.mode.idle');
    return i18n.t('play.mode.free');
  }

  renderRunner(cols, heat) {
    const { t } = i18n;
    const overlay = !this.started ? t('play.runner.start') : this.paused ? t('play.paused') : !this.run.alive ? t('play.runner.over', { score: this.run.score }) : '';
    return views.runnerView(this.run, { style: this.style, cols, pulse: this.mode === 'waiting' ? heat : term.pulseFor(0), started: this.started, overlay });
  }

  renderTermo(rows) {
    const { style } = this;
    const lines = [];
    if (this.tm.over) {
      lines.push(style.paint(this.tm.won ? i18n.t('play.termo.won', { n: this.tm.guesses.length }) : i18n.t('play.termo.lost', { word: this.tm.answer }), { fg: this.tm.won ? 'lime' : 'amber', bold: true }));
      if (rows >= 34) lines.push('', ...views.termoView(this.tm, { style, rows, buffer: '', wordLen: termo.WORD_LEN, maxGuesses: termo.MAX_GUESSES }));
      return lines;
    }
    lines.push(...views.termoView(this.tm, { style, rows, buffer: this.buffer, wordLen: termo.WORD_LEN, maxGuesses: termo.MAX_GUESSES }));
    if (this.notice) lines.push('', style.paint(this.notice, { fg: 'amber' }));
    return lines;
  }
}

const ARROWS = { A: 'up', B: 'down', C: 'right', D: 'left' };

/** Raw stdin chunk → normalized key list. Arrow sequences (ESC [ A, ESC O A) become 'up'…; other escape sequences are dropped. */
function parseKeys(chunk) {
  const s = String(chunk);
  if (s === '\x1b') return ['esc'];
  const chars = Array.from(s);
  const keys = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\x1b') {
      const next = chars[i + 1];
      if (next === '[' || next === 'O') {
        let j = i + 2;
        while (j < chars.length && /[0-9;?]/.test(chars[j])) j++; // parameters (e.g. 1;5 for Ctrl+arrow)
        if (chars[j] && ARROWS[chars[j]]) keys.push(ARROWS[chars[j]]);
        i = j; // the final byte belongs to the sequence
      } else if (next !== undefined) i += 1; // ESC + key (Alt+key): drop both
      continue;
    }
    if (ch === '\x03') keys.push('ctrl-c');
    else if (ch === '\r' || ch === '\n') keys.push('enter');
    else if (ch === '\x7f' || ch === '\b') keys.push('backspace');
    else if (ch === ' ') keys.push(' ');
    else if (ch === '-' || ch === '=') keys.push(ch);
    else if (/^[A-Za-z0-9]$/.test(ch)) keys.push(ch.toLowerCase());
  }
  return keys;
}

module.exports = { PlaySession, parseKeys, GAMES };

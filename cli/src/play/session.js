'use strict';

/**
 * PlaySession — everything `meshad play` does except touching the terminal.
 * Keys in, text lines out, state file polled through the bridge. The TTY shell
 * (play/ui.js) is a thin loop around this, so pause/resume, input handling and
 * rendering are all testable without a PTY.
 *
 * Keys are normalized strings: ' ' · 'enter' · 'backspace' · 'esc' · 'ctrl-c' ·
 * or one lowercase letter / digit.
 */

const bridge = require('./bridge');
const runner = require('./runner');
const termo = require('./termo');
const { seedFor, utcDate } = require('./rng');
const i18n = require('../i18n');

const GAMES = ['runner', 'termo'];

const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const BG = { G: '\x1b[42;30m', Y: '\x1b[43;30m', B: '\x1b[100;37m' };
const cell = (ch, mark) => `${BG[mark]} ${ch.toUpperCase()} \x1b[0m`;

class PlaySession {
  /**
   * @param {object} o
   * @param {string|null} o.game       'runner' | 'termo' | null (menu)
   * @param {string} o.dir             config dir (bridge location)
   * @param {string[]} [o.skinLines]   verified sponsor banner, or []
   * @param {() => number} [o.now]
   */
  constructor({ game = null, dir, skinLines = [], now = Date.now }) {
    this.dir = dir;
    this.skinLines = skinLines;
    this.now = now;
    this.done = false;
    this.override = false; // player chose to keep playing while the agent answers
    this.mode = 'free';
    this.paused = false;
    this.game = null;
    this.shareText = null; // set when a game finishes — printed after leaving the alt screen
    this.result = null; // {game,date,score,log} of a finished, scoreable game — what a leaderboard replay needs
    if (game) this.start(game);
    this.poll();
  }

  start(game) {
    this.game = game;
    this.date = utcDate(this.now());
    this.paused = false;
    this.shareText = null;
    this.result = null;
    if (game === 'runner') {
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
    }
    return this.gate;
  }

  /** 'run' | 'frozen' */
  get gate() {
    return this.override ? 'run' : this.mode === 'idle' ? 'frozen' : 'run';
  }

  /** One fixed runner tick (TICK_MS). No-op unless the game is live. */
  tick() {
    if (this.game !== 'runner' || !this.started || this.paused || !this.run.alive || this.gate === 'frozen') return;
    if (this.pendingJump) this.jumpLog.push(this.run.tick);
    runner.step(this.run, this.pendingJump);
    this.pendingJump = false;
    if (this.run.alive && this.run.tick >= runner.MAX_TICKS) this.run.alive = false; // run cap, same as the server replay
    if (!this.run.alive) this.finishRunner();
  }

  finishRunner() {
    this.shareText = runner.shareString(this.date, this.run.score);
    if (this.run.score > 0) this.result = { game: 'runner', date: this.date, score: this.run.score, log: this.jumpLog.slice() };
  }

  key(k) {
    if (k === 'ctrl-c') { this.done = true; return; }
    if (this.game === null) return this.menuKey(k);
    if (k === 'esc' || (this.game === 'runner' && k === 'q')) { this.done = true; return; }

    // Frozen: the only live key is Space → keep playing (free-play).
    if (this.gate === 'frozen') {
      if (k === ' ') this.override = true;
      return;
    }
    return this.game === 'runner' ? this.runnerKey(k) : this.termoKey(k);
  }

  menuKey(k) {
    if (k === 'esc') this.done = true;
    else if (k === '1') this.start('runner');
    else if (k === '2') this.start('termo');
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
        this.shareText = termo.shareString(this.tm);
        if (this.tm.won) this.result = { game: 'termo', date: this.date, score: termo.score(this.tm), log: this.tm.guesses.slice() };
      }
    } else if (/^[a-z]$/.test(k) && this.buffer.length < termo.WORD_LEN) this.buffer += k;
  }

  /** Lines to draw (each already styled, none wider than `cols`). */
  render(cols = 80, rows = 24) {
    const out = [];
    if (this.skinLines.length) out.push(...this.skinLines, '');
    if (this.game === null) {
      out.push(bold('MeshAd Play'), '', i18n.t('play.menu'));
      return out;
    }
    const title = i18n.t(`play.title.${this.game}`);
    out.push(`${bold(title)} ${dim(this.date)}`);
    out.push(dim(this.statusLine()));
    out.push('');
    out.push(...(this.game === 'runner' ? this.renderRunner(cols) : this.renderTermo()));
    out.push('');
    if (this.gate === 'frozen') out.push(i18n.t('play.hint.frozen'));
    out.push(dim(i18n.t(`play.keys.${this.game}`)));
    if (this.shareText) out.push('', i18n.t('play.share.title'), ...this.shareText.split('\n'));
    return out.slice(0, Math.max(1, rows - 1));
  }

  statusLine() {
    if (this.override && this.mode === 'idle') return i18n.t('play.mode.override');
    if (this.mode === 'waiting') return i18n.t('play.mode.waiting');
    if (this.mode === 'idle') return i18n.t('play.mode.idle');
    return i18n.t('play.mode.free');
  }

  renderRunner(cols) {
    const width = Math.max(10, Math.min(runner.FIELD_W, cols - 1));
    const rows = runner.frame(this.run).map((r) => r.slice(0, width));
    if (!this.started) rows.push('', i18n.t('play.runner.start'));
    else if (this.paused) rows.push('', i18n.t('play.paused'));
    else if (!this.run.alive) rows.push('', i18n.t('play.runner.over', { score: this.run.score }));
    else rows.push('', `${this.run.score}m`);
    return rows;
  }

  renderTermo() {
    const lines = [];
    for (let r = 0; r < termo.MAX_GUESSES; r++) {
      const g = this.tm.guesses[r];
      if (g) lines.push(g.split('').map((ch, i) => cell(ch, this.tm.marks[r][i])).join(''));
      else if (r === this.tm.guesses.length && !this.tm.over) {
        lines.push(Array.from({ length: termo.WORD_LEN }, (_, i) => ` ${(this.buffer[i] || '_').toUpperCase()} `).join(''));
      } else lines.push(Array.from({ length: termo.WORD_LEN }, () => ' · ').join(''));
    }
    if (this.notice) lines.push('', this.notice);
    if (this.tm.over) {
      lines.push('', this.tm.won ? i18n.t('play.termo.won', { n: this.tm.guesses.length }) : i18n.t('play.termo.lost', { word: this.tm.answer }));
    }
    return lines;
  }
}

/** Raw stdin chunk → normalized key list. Escape sequences (arrows…) are dropped. */
function parseKeys(chunk) {
  const s = String(chunk);
  if (s === '\x1b') return ['esc'];
  if (s.startsWith('\x1b')) return [];
  const keys = [];
  for (const ch of s) {
    if (ch === '\x03') keys.push('ctrl-c');
    else if (ch === '\r' || ch === '\n') keys.push('enter');
    else if (ch === '\x7f' || ch === '\b') keys.push('backspace');
    else if (ch === ' ') keys.push(' ');
    else if (/^[A-Za-z0-9]$/.test(ch)) keys.push(ch.toLowerCase());
  }
  return keys;
}

module.exports = { PlaySession, parseKeys, GAMES };

'use strict';

/**
 * Controllers for the five newer games (snake, flappy, blocks, slide, chess):
 * the glue between PlaySession's keys/ticks and a pure engine. Each controller
 * owns its input log in exactly the format the engine's `simulate`/`replay` and
 * the leaderboard replay expect — the log records the engine tick at which an
 * input was APPLIED, never wall-clock time, so (seed, log) → score is exact.
 *
 * Shared surface (what session.js reads):
 *   id, realtime, tickMs, started, paused, over, won, score
 *   key(k)  tick()  log()  result()  shareText()  barScore()
 * No I/O, no clock, no rendering — views live in views-arcade.js.
 */

const snake = require('./snake');
const flappy = require('./flappy');
const blocks = require('./blocks');
const slide = require('./slide');
const chess = require('./chess');
const { seedFor } = require('./rng');

const IDLE_TICK_MS = 100; // turn-based games: just a redraw heartbeat

/** arrows / WASD / hjkl → 'u' | 'd' | 'l' | 'r' (or null). */
function dirOf(k) {
  switch (k) {
    case 'up': case 'w': case 'k': return 'u';
    case 'down': case 's': case 'j': return 'd';
    case 'left': case 'a': case 'h': return 'l';
    case 'right': case 'd': case 'l': return 'r';
    default: return null;
  }
}

class SnakeGame {
  constructor(date) {
    this.id = 'snake';
    this.realtime = true;
    this.tickMs = snake.TICK_MS;
    this.date = date;
    this.s = snake.create(seedFor(date, 'snake'));
    this.started = false;
    this.paused = false;
    this.queue = []; // turns waiting for a tick (at most one is applied per tick)
    this.turns = []; // [[tick, dir], ...]
  }

  get over() { return this.s.over || this.s.tick >= snake.MAX_TICKS; }
  get won() { return true; }
  get score() { return this.s.score; }

  key(k) {
    if (this.over) return;
    if (k === 'p' && this.started) { this.paused = !this.paused; return; }
    if (this.paused) return;
    const d = dirOf(k);
    if (!this.started) {
      if (k !== ' ' && !d) return;
      this.started = true;
    }
    if (!d) return;
    const last = this.queue.length ? this.queue[this.queue.length - 1] : this.s.dir;
    const opposite = { u: 'd', d: 'u', l: 'r', r: 'l' }[last];
    if (d !== last && d !== opposite && this.queue.length < 3) this.queue.push(d);
  }

  tick() {
    if (!this.started || this.paused || this.over) return;
    const turn = this.queue.shift() || null;
    if (turn) this.turns.push([this.s.tick, turn]);
    snake.step(this.s, turn);
  }

  log() { return this.turns.map((t) => t.slice()); }
  result() { return this.over && this.score > 0 ? { score: this.score, log: this.log() } : null; }
  shareText() { return snake.shareString(this.date, this.score); }
  barScore() { return `${this.score}`; }
}

class FlappyGame {
  constructor(date) {
    this.id = 'flappy';
    this.realtime = true;
    this.tickMs = flappy.TICK_MS;
    this.date = date;
    this.s = flappy.create(seedFor(date, 'flappy'));
    this.started = false;
    this.paused = false;
    this.pendingFlap = false;
    this.flaps = [];
  }

  get over() { return !this.s.alive || this.s.tick >= flappy.MAX_TICKS; }
  get won() { return true; }
  get score() { return this.s.score; }

  key(k) {
    if (this.over) return;
    if (k === 'p' && this.started) { this.paused = !this.paused; return; }
    if (this.paused) return;
    if (!this.started) { if (k === ' ') this.started = true; return; }
    if (k === ' ' || k === 'up' || k === 'w' || k === 'k') this.pendingFlap = true;
  }

  tick() {
    if (!this.started || this.paused || this.over) return;
    if (this.pendingFlap) this.flaps.push(this.s.tick);
    flappy.step(this.s, this.pendingFlap);
    this.pendingFlap = false;
  }

  log() { return this.flaps.slice(); }
  result() { return this.over && this.score > 0 ? { score: this.score, log: this.log() } : null; }
  shareText() { return flappy.shareString(this.date, this.score); }
  barScore() { return `${this.score}`; }
}

const BLOCK_KEYS = {
  left: 'l', a: 'l', h: 'l',
  right: 'r', d: 'r', l: 'r',
  up: 'cw', x: 'cw', w: 'cw', k: 'cw',
  z: 'ccw',
  down: 'soft', s: 'soft', j: 'soft',
  ' ': 'hard',
};
const MAX_ACTIONS_PER_TICK = 6;

class BlocksGame {
  constructor(date) {
    this.id = 'blocks';
    this.realtime = true;
    this.tickMs = blocks.TICK_MS;
    this.date = date;
    this.s = blocks.create(seedFor(date, 'blocks'));
    this.started = false;
    this.paused = false;
    this.pending = [];
    this.actions = []; // [[tick, action], ...]
  }

  get over() { return this.s.over || this.s.tick >= blocks.MAX_TICKS; }
  get won() { return true; }
  get score() { return this.s.score; }

  key(k) {
    if (this.over) return;
    if (k === 'p' && this.started) { this.paused = !this.paused; return; }
    if (this.paused) return;
    if (!this.started) { if (k === ' ') this.started = true; return; }
    const a = BLOCK_KEYS[k];
    if (a && this.pending.length < MAX_ACTIONS_PER_TICK) this.pending.push(a);
  }

  tick() {
    if (!this.started || this.paused || this.over) return;
    const acts = this.pending.splice(0).slice(0, Math.max(0, blocks.MAX_LOG - this.actions.length));
    for (const a of acts) this.actions.push([this.s.tick, a]);
    blocks.step(this.s, acts);
  }

  log() { return this.actions.map((a) => a.slice()); }
  result() { return this.over && this.score > 0 ? { score: this.score, log: this.log() } : null; }
  shareText() { return blocks.shareString(this.date, this.score, this.s.lines); }
  barScore() { return `${this.score}`; }
}

class SlideGame {
  constructor(date) {
    this.id = 'slide';
    this.realtime = false;
    this.tickMs = IDLE_TICK_MS;
    this.date = date;
    this.s = slide.create(seedFor(date, 'slide'));
    this.started = true;
    this.paused = false;
    this.moves = [];
    this.ended = false; // the player stopped (Esc) with a score on the board
    this.blocked = false; // the last key was a move that changes nothing
  }

  get over() { return this.s.over || this.ended || this.s.moves >= slide.MAX_MOVES; }
  get won() { return true; }
  get score() { return this.s.score; }
  get maxTile() { return Math.max(...this.s.board); }

  key(k) {
    if (this.over) return;
    const d = dirOf(k);
    if (!d) return;
    this.blocked = !slide.move(this.s, d);
    if (!this.blocked) this.moves.push(d);
  }

  /** Esc on a board that is not stuck: bank what was scored. */
  end() { if (!this.over && this.score > 0) this.ended = true; }

  tick() {}
  log() { return this.moves.slice(); }
  result() { return this.over && this.moves.length > 0 && this.score > 0 ? { score: this.score, log: this.log() } : null; }
  shareText() { return slide.shareString(this.date, this.score, this.maxTile); }
  barScore() { return `${this.score}`; }
}

const CHESS_CHARS = /^[a-z0-9=-]$/;
const MAX_INPUT = 8;

class ChessGame {
  constructor(date) {
    this.id = 'chess';
    this.realtime = false;
    this.tickMs = IDLE_TICK_MS;
    this.date = date;
    this.s = chess.create(date);
    this.side = this.s.pos.turn; // the player's colour: the side to move after the opponent's first move
    this.started = true;
    this.paused = false;
    this.buffer = '';
    this.notice = null; // {kind, ...} → the message line (session translates it)
  }

  get over() { return this.s.over; }
  get won() { return this.s.solved; }
  get score() { return chess.score(this.s); }
  get lives() { return chess.MAX_MISTAKES - this.s.mistakes; }

  key(k) {
    if (this.over) return;
    if (k === 'backspace') { this.buffer = this.buffer.slice(0, -1); this.notice = null; return; }
    if (k === 'enter') { this.submit(); return; }
    if (CHESS_CHARS.test(k) && this.buffer.length < MAX_INPUT) { this.buffer += k; this.notice = null; }
  }

  /** Typed text is lower-cased by the key layer: try it as typed, then as SAN ('nf3' → 'Nf3', 'o-o' → 'O-O'). */
  candidates() {
    const b = this.buffer;
    const out = [b];
    if (/^[nbrqk][a-h1-8x]/.test(b)) out.push(b[0].toUpperCase() + b.slice(1));
    if (/^o-o(-o)?$/.test(b)) out.push(b.toUpperCase());
    return out;
  }

  submit() {
    if (!this.buffer) return;
    const text = this.candidates().find((c) => chess.parseMove(this.s.pos, c)) || this.buffer;
    const r = chess.play(this.s, text);
    this.notice = r.ok ? { kind: r.result, move: r.move, reply: r.reply || null } : { kind: r.reason };
    this.buffer = '';
  }

  tick() {}
  log() { return this.s.log.slice(); }
  result() { return this.over && this.s.solved ? { score: this.score, log: this.log() } : null; }
  shareText() { return chess.shareString(this.s); }
  barScore() { return `${chess.MAX_SCORE - this.s.mistakes}`; }
}

const CONTROLLERS = { snake: SnakeGame, flappy: FlappyGame, blocks: BlocksGame, slide: SlideGame, chess: ChessGame };
const ARCADE = Object.keys(CONTROLLERS);

function create(game, date) {
  return new CONTROLLERS[game](date);
}

module.exports = { ARCADE, IDLE_TICK_MS, create, dirOf };

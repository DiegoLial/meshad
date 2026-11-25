'use strict';

/**
 * Meshad Blocks — falling-piece line-clearing game. Pure engine: no I/O, no
 * clock, no randomness beyond the seeded PRNG (the 7-bag). `step` advances one
 * fixed tick: the given actions are applied in order, then gravity.
 *
 * Log format: [[tick, action], ...] with non-decreasing ticks; several actions
 * may share a tick (applied in log order). Actions:
 *   'l' | 'r'      move left / right
 *   'cw' | 'ccw'   rotate (simple wall kicks, see KICKS)
 *   'soft'         move down one row (+1 point per row)
 *   'hard'         drop to the bottom and lock at once (+2 points per row)
 *
 * Board: BOARD_W x BOARD_H, row 0 on top. Cells are 0 (empty) or a piece
 * index 1..7 (see PIECES).
 */

const { makeRng } = require('./rng');

const BOARD_W = 10;
const BOARD_H = 20;
const TICK_MS = 50;
/** A run ends here even if the stack is alive (~5 min). The server replays with the same cap. */
const MAX_TICKS = 6000;
/** Most log entries the server will replay. */
const MAX_LOG = 8000;
const ACTIONS = ['l', 'r', 'cw', 'ccw', 'soft', 'hard'];
const PIECES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
/** Loose upper bound (≤ 1 piece per tick, level-10 multiplier); the replay is the exact check. */
const MAX_SCORE = 6_000_000;
const MAX_LEVEL = 10;
const LINE_POINTS = [0, 100, 300, 500, 800]; // × (level + 1)
/** Ticks per gravity row, by level. */
const GRAVITY_TICKS = [20, 17, 14, 11, 9, 7, 6, 5, 4, 3, 2];
/** Tried in order after a rotation; first that fits wins. */
const KICKS = [[0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0]];

// Spawn orientation: cells inside an n x n box, (x, y) with y growing downward.
const BASE = {
  I: { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { n: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};

/** SHAPES[type][rot] = 4 cells, rot 0..3 clockwise. */
const SHAPES = Object.fromEntries(PIECES.map((t) => {
  const { n, cells } = BASE[t];
  const rots = [cells];
  for (let r = 1; r < 4; r++) rots.push(rots[r - 1].map(([x, y]) => [n - 1 - y, x]));
  return [t, rots];
}));

function create(seed) {
  const state = {
    seed, rng: makeRng(seed), tick: 0,
    board: Array.from({ length: BOARD_H }, () => Array(BOARD_W).fill(0)),
    queue: [], cur: null, dropIn: GRAVITY_TICKS[0],
    score: 0, lines: 0, level: 0, pieces: 0, over: false,
  };
  spawn(state);
  return state;
}

function refill(state) {
  while (state.queue.length < 7) {
    const bag = PIECES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = state.rng.int(i + 1);
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    state.queue.push(...bag);
  }
}

function spawn(state) {
  refill(state);
  const type = state.queue.shift();
  refill(state);
  state.cur = { type, rot: 0, x: Math.floor((BOARD_W - BASE[type].n) / 2), y: 0 };
  state.dropIn = GRAVITY_TICKS[state.level];
  state.pieces += 1;
  if (collides(state.board, state.cur)) state.over = true;
}

/** Absolute [x, y] cells of a piece. */
function cellsOf(p) {
  return SHAPES[p.type][p.rot].map(([x, y]) => [p.x + x, p.y + y]);
}

function collides(board, p) {
  return cellsOf(p).some(([x, y]) => x < 0 || x >= BOARD_W || y >= BOARD_H || (y >= 0 && board[y][x] !== 0));
}

/** Row the current piece would lock on if hard-dropped (for a ghost). */
function dropY(state) {
  let y = state.cur.y;
  while (!collides(state.board, { ...state.cur, y: y + 1 })) y += 1;
  return y;
}

function tryMove(state, dx, dy) {
  const next = { ...state.cur, x: state.cur.x + dx, y: state.cur.y + dy };
  if (collides(state.board, next)) return false;
  state.cur = next;
  return true;
}

function rotate(state, dir) {
  const rot = (state.cur.rot + dir + 4) % 4;
  for (const [dx, dy] of KICKS) {
    const next = { ...state.cur, rot, x: state.cur.x + dx, y: state.cur.y + dy };
    if (!collides(state.board, next)) { state.cur = next; return true; }
  }
  return false;
}

function lock(state) {
  const idx = PIECES.indexOf(state.cur.type) + 1;
  for (const [x, y] of cellsOf(state.cur)) if (y >= 0) state.board[y][x] = idx;
  const kept = state.board.filter((row) => row.some((c) => c === 0));
  const cleared = BOARD_H - kept.length;
  if (cleared > 0) {
    state.score += LINE_POINTS[cleared] * (state.level + 1);
    state.lines += cleared;
    state.level = Math.min(MAX_LEVEL, Math.floor(state.lines / 10));
    state.board = [...Array.from({ length: cleared }, () => Array(BOARD_W).fill(0)), ...kept];
  }
  spawn(state);
}

function apply(state, action) {
  if (action === 'l') tryMove(state, -1, 0);
  else if (action === 'r') tryMove(state, 1, 0);
  else if (action === 'cw') rotate(state, 1);
  else if (action === 'ccw') rotate(state, -1);
  else if (action === 'soft') { if (tryMove(state, 0, 1)) state.score += 1; }
  else if (action === 'hard') {
    let n = 0;
    while (tryMove(state, 0, 1)) n += 1;
    state.score += 2 * n;
    lock(state);
    return true; // locked
  }
  return false;
}

/** Advance one tick: apply `actions` in order, then gravity. */
function step(state, actions = []) {
  if (state.over) return state;
  let locked = false;
  for (const a of actions) {
    locked = apply(state, a) || locked;
    if (state.over) break;
  }
  if (!state.over && !locked) {
    state.dropIn -= 1;
    if (state.dropIn <= 0) {
      state.dropIn = GRAVITY_TICKS[state.level];
      if (!tryMove(state, 0, 1)) lock(state);
    }
  }
  state.tick += 1;
  return state;
}

/** Run a whole game from a seed and a [[tick, action]] log. Stops at game over or `maxTicks`. */
function simulate(seed, log = [], maxTicks = MAX_TICKS) {
  const state = create(seed);
  let i = 0;
  while (!state.over && state.tick < maxTicks) {
    const acts = [];
    while (i < log.length && log[i][0] <= state.tick) acts.push(log[i++][1]);
    step(state, acts);
  }
  return { score: state.score, lines: state.lines, level: state.level, ticks: state.tick, over: state.over || state.tick >= maxTicks };
}

function shareString(date, score, lines) {
  return `Meshad Blocks ${date}\n🧱 ${score} · ${lines} lines`;
}

module.exports = {
  BOARD_W, BOARD_H, TICK_MS, MAX_TICKS, MAX_LOG, MAX_SCORE, MAX_LEVEL, ACTIONS, PIECES, SHAPES, LINE_POINTS, GRAVITY_TICKS,
  create, step, simulate, cellsOf, collides, dropY, shareString,
};

'use strict';

/**
 * Slide — a 2048-style merge puzzle. Pure engine: no I/O, no clock, no
 * randomness beyond the seeded PRNG (tile spawns). Every legal move spawns one
 * tile, so (seed, move log) fully determine the game.
 *
 * Log format: ['l'|'r'|'u'|'d', ...]. A move that changes nothing is illegal:
 * the engine ignores it and the leaderboard refuses logs containing one.
 * Score = sum of the values of all tiles created by merges.
 *
 * Board: flat array of SIZE*SIZE values, row-major, 0 = empty.
 */

const { makeRng } = require('./rng');

const SIZE = 4;
/** Most moves the server will replay. */
const MAX_MOVES = 2000;
const MOVES = ['l', 'r', 'u', 'd'];
/** Total tile value grows by ≤ 4 per move and each unit of value can merge at most ~17 times. */
const MAX_SCORE = MAX_MOVES * 4 * 17;

function create(seed) {
  const state = { seed, rng: makeRng(seed), board: Array(SIZE * SIZE).fill(0), score: 0, moves: 0, over: false };
  spawn(state);
  spawn(state);
  return state;
}

/** 90% a 2, 10% a 4, on a seeded empty cell. */
function spawn(state) {
  const empty = [];
  state.board.forEach((v, i) => { if (v === 0) empty.push(i); });
  if (empty.length === 0) return;
  const cell = empty[state.rng.int(empty.length)];
  state.board[cell] = state.rng.int(10) < 9 ? 2 : 4;
}

/** Slide one line toward index 0 and merge equal neighbours once each. Pure. */
function slideLine(line) {
  const tiles = line.filter((v) => v !== 0);
  const out = [];
  let gained = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      out.push(tiles[i] * 2);
      gained += tiles[i] * 2;
      i += 1;
    } else {
      out.push(tiles[i]);
    }
  }
  while (out.length < SIZE) out.push(0);
  return { line: out, gained };
}

/** Board indices of each line, ordered from the edge tiles slide toward. */
function linesFor(dir) {
  const lines = [];
  for (let a = 0; a < SIZE; a++) {
    const idx = [];
    for (let b = 0; b < SIZE; b++) {
      idx.push(dir === 'l' ? a * SIZE + b : dir === 'r' ? a * SIZE + (SIZE - 1 - b) : dir === 'u' ? b * SIZE + a : (SIZE - 1 - b) * SIZE + a);
    }
    lines.push(idx);
  }
  return lines;
}

function canMove(board) {
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0) return true;
    if ((i % SIZE < SIZE - 1 && board[i] === board[i + 1]) || (i + SIZE < board.length && board[i] === board[i + SIZE])) return true;
  }
  return false;
}

/** Apply a move. Returns false (state untouched) when illegal or the game is over. */
function move(state, dir) {
  if (state.over || !MOVES.includes(dir)) return false;
  const next = state.board.slice();
  let gained = 0;
  for (const idx of linesFor(dir)) {
    const r = slideLine(idx.map((i) => state.board[i]));
    gained += r.gained;
    idx.forEach((i, k) => { next[i] = r.line[k]; });
  }
  if (next.every((v, i) => v === state.board[i])) return false;
  state.board = next;
  state.score += gained;
  state.moves += 1;
  spawn(state);
  state.over = !canMove(state.board);
  return true;
}

/** Replay a move log. `illegal` counts ignored entries; `consumed` how many entries were looked at. */
function simulate(seed, log = [], maxMoves = MAX_MOVES) {
  const state = create(seed);
  let illegal = 0;
  let consumed = 0;
  for (const d of log) {
    if (state.over || state.moves >= maxMoves) break;
    consumed += 1;
    if (!move(state, d)) illegal += 1;
  }
  return { score: state.score, moves: state.moves, over: state.over || state.moves >= maxMoves, illegal, consumed, maxTile: Math.max(...state.board) };
}

function shareString(date, score, maxTile) {
  return `Slide ${date}\n🔢 ${score} · best tile ${maxTile}`;
}

module.exports = { SIZE, MAX_MOVES, MAX_SCORE, MOVES, create, move, slideLine, canMove, simulate, shareString };

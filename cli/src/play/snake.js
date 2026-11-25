'use strict';

/**
 * Snake — pure engine for `meshad play`. No I/O, no clock, no randomness beyond
 * the seeded PRNG (food placement). `step` advances one fixed tick, so
 * (seed, turn log) fully determine the run — the replay contract the leaderboard
 * relies on. Fixed logical grid; the UI may draw two cells per character row
 * (half-blocks) but never changes the simulation.
 *
 * Log format: [[tick, dir], ...] with strictly increasing ticks and dir in
 * 'u' | 'd' | 'l' | 'r'. The turn is applied at the start of that tick, before
 * the snake moves. A turn straight back into the neck is ignored.
 */

const { makeRng } = require('./rng');

const GRID_W = 24;
const GRID_H = 14;
const TICK_MS = 120;
const START_LEN = 3;
/** A run ends here even if the snake is alive (~6 min). The server replays with the same cap. */
const MAX_TICKS = 3000;
/** Food eaten can never exceed the free cells at the start. */
const MAX_SCORE = GRID_W * GRID_H - START_LEN;
const DIRS = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] };
const OPPOSITE = { u: 'd', d: 'u', l: 'r', r: 'l' };

function create(seed) {
  const rng = makeRng(seed);
  const hx = Math.floor(GRID_W / 2);
  const hy = Math.floor(GRID_H / 2);
  const snake = Array.from({ length: START_LEN }, (_, i) => ({ x: hx - i, y: hy })); // head first
  const state = { seed, rng, tick: 0, snake, dir: 'r', food: null, score: 0, over: false, won: false, cause: null };
  state.food = placeFood(state);
  return state;
}

/** Seeded pick among the free cells (row-major order), or null when the board is full. */
function placeFood(state) {
  const taken = new Set(state.snake.map((c) => c.y * GRID_W + c.x));
  const free = [];
  for (let i = 0; i < GRID_W * GRID_H; i++) if (!taken.has(i)) free.push(i);
  if (free.length === 0) return null;
  const i = free[state.rng.int(free.length)];
  return { x: i % GRID_W, y: Math.floor(i / GRID_W) };
}

/** Advance one tick. `turn` = 'u'|'d'|'l'|'r' pressed since the last tick, or null. */
function step(state, turn = null) {
  if (state.over) return state;
  if (turn && DIRS[turn] && turn !== OPPOSITE[state.dir]) state.dir = turn;

  const [dx, dy] = DIRS[state.dir];
  const head = { x: state.snake[0].x + dx, y: state.snake[0].y + dy };
  state.tick += 1;
  if (head.x < 0 || head.x >= GRID_W || head.y < 0 || head.y >= GRID_H) return die(state, 'wall');

  const eats = state.food !== null && head.x === state.food.x && head.y === state.food.y;
  // The tail cell is vacated this tick unless the snake grows, so stepping onto it is legal.
  const body = eats ? state.snake : state.snake.slice(0, -1);
  if (body.some((c) => c.x === head.x && c.y === head.y)) return die(state, 'self');

  state.snake.unshift(head);
  if (eats) {
    state.score += 1;
    state.food = placeFood(state);
    if (state.food === null) {
      state.over = true;
      state.won = true;
      state.cause = 'full';
    }
  } else {
    state.snake.pop();
  }
  return state;
}

function die(state, cause) {
  state.over = true;
  state.cause = cause;
  return state;
}

/** Run a whole game from a seed and a [[tick, dir]] log. Stops at death or `maxTicks`. */
function simulate(seed, log = [], maxTicks = MAX_TICKS) {
  const turns = new Map(log.map(([t, d]) => [t, d]));
  const state = create(seed);
  while (!state.over && state.tick < maxTicks) step(state, turns.get(state.tick) ?? null);
  return { score: state.score, ticks: state.tick, over: state.over || state.tick >= maxTicks, cause: state.cause };
}

function shareString(date, score) {
  return `Snake ${date}\n🐍 ${score}`;
}

module.exports = { GRID_W, GRID_H, TICK_MS, START_LEN, MAX_TICKS, MAX_SCORE, DIRS, create, step, simulate, shareString };

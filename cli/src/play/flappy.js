'use strict';

/**
 * Flappy Term — one-key flap-through-the-gaps game. Pure engine: no I/O, no
 * clock, no randomness beyond the seeded PRNG (pipe gaps). Physics is integer
 * fixed-point only (SUB units per row), so a replay can never diverge between
 * machines. `step` advances one fixed tick.
 *
 * Log format: [tick, ...] — the ticks at which flap was pressed, strictly
 * increasing, each inside the run. A flap sets the vertical speed; gravity
 * pulls it back every tick.
 *
 * Field: FIELD_W x FIELD_H cells. The bird sits in column BIRD_X; pipes scroll
 * one column per tick and are PIPE_W wide with a GAP-row opening.
 */

const { makeRng } = require('./rng');

const FIELD_W = 40;
const FIELD_H = 20;
const BIRD_X = 8;
/** Fixed-point: y and vy are in 1/SUB rows (vy per tick). */
const SUB = 1000;
const GRAVITY = 90;
const FLAP_V = -1000;
const MAX_FALL = 1100;
const START_Y = 10 * SUB;
const PIPE_W = 3;
const GAP = 7;
const SPACING = 18; // ticks (= columns, speed is 1) between pipe spawns
const TICK_MS = 60;
/** A run ends here even if the bird is alive (~3 min). The server replays with the same cap. */
const MAX_TICKS = 3000;
/** Pipes spawn every SPACING ticks and the first needs FIELD_W - BIRD_X ticks to arrive. */
const MAX_SCORE = Math.ceil(MAX_TICKS / SPACING);

function create(seed) {
  return { seed, rng: makeRng(seed), tick: 0, y: START_Y, vy: 0, pipes: [], nextSpawnIn: 1, alive: true, score: 0 };
}

/** Row the bird currently occupies (0 = top). */
function birdRow(state) {
  return Math.floor(state.y / SUB);
}

/** Advance one tick. `flap` = the flap key was pressed since the last tick. */
function step(state, flap = false) {
  if (!state.alive) return state;

  state.vy = flap ? FLAP_V : state.vy;
  state.vy = Math.min(MAX_FALL, state.vy + GRAVITY);
  state.y += state.vy;

  for (const p of state.pipes) p.x -= 1;
  state.pipes = state.pipes.filter((p) => p.x + PIPE_W > 0);
  state.nextSpawnIn -= 1;
  if (state.nextSpawnIn <= 0) {
    state.pipes.push({ x: FIELD_W, gapTop: 2 + state.rng.int(FIELD_H - GAP - 3), passed: false });
    state.nextSpawnIn = SPACING;
  }

  state.tick += 1;
  const row = birdRow(state);
  if (state.y < 0 || row >= FIELD_H) { state.alive = false; return state; }
  for (const p of state.pipes) {
    if (p.x <= BIRD_X && BIRD_X < p.x + PIPE_W && (row < p.gapTop || row >= p.gapTop + GAP)) {
      state.alive = false;
      return state;
    }
  }
  for (const p of state.pipes) {
    if (!p.passed && p.x + PIPE_W <= BIRD_X) {
      p.passed = true;
      state.score += 1;
    }
  }
  return state;
}

/** Run a whole game from a seed and the ticks at which flap was pressed. Stops at death or `maxTicks`. */
function simulate(seed, flapTicks = [], maxTicks = MAX_TICKS) {
  const flaps = new Set(flapTicks);
  const state = create(seed);
  while (state.alive && state.tick < maxTicks) step(state, flaps.has(state.tick));
  return { score: state.score, ticks: state.tick, over: !state.alive || state.tick >= maxTicks, alive: state.alive };
}

function shareString(date, score) {
  return `Flappy Term ${date}\n🐦 ${score}`;
}

module.exports = {
  FIELD_W, FIELD_H, BIRD_X, SUB, GRAVITY, FLAP_V, MAX_FALL, PIPE_W, GAP, SPACING, TICK_MS, MAX_TICKS, MAX_SCORE,
  create, step, simulate, birdRow, shareString,
};

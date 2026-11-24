'use strict';

/**
 * Wait Runner — a one-key dino-style runner. Pure engine: no I/O, no clock, no
 * randomness beyond the seeded PRNG. `step` advances one fixed tick, so
 * (seed, jump inputs) fully determine the run — that is the replay contract
 * the tests pin down.
 *
 * Geometry is integer cells on a fixed logical field (FIELD_W); the UI crops
 * or pads it to the terminal, it never changes the simulation.
 */

const { makeRng } = require('./rng');

const FIELD_W = 48;
const DINO_X = 4;
const TICK_MS = 50;
/** Dino height (rows above ground) per tick of a jump. Peak 3, ~0.5s airborne. */
const ARC = [1, 2, 3, 3, 3, 3, 3, 2, 1];
// At MAX_SPEED the arc covers 2*ARC.length cols; a gap shorter than that + obstacle
// width would make back-to-back obstacles impossible to clear.
const MIN_GAP = 26;
const GAP_SPREAD = 16;
const SPEEDUP_EVERY = 400; // ticks per +1 col/tick, capped at MAX_SPEED
const MAX_SPEED = 2;
/** A run ends here even if the dino is still alive (~4 min). The server replays with the same cap. */
const MAX_TICKS = 5000;

function create(seed) {
  const rng = makeRng(seed);
  return {
    seed,
    rng,
    tick: 0,
    jumpT: -1, // -1 grounded, else index into ARC
    obstacles: [], // {x, w, h}
    nextSpawnIn: 24,
    alive: true,
    score: 0,
  };
}

/** Rows above ground the dino currently occupies (0 = on the floor). */
function dinoHeight(state) {
  return state.jumpT >= 0 ? ARC[state.jumpT] : 0;
}

function speedAt(tick) {
  return Math.min(MAX_SPEED, 1 + Math.floor(tick / SPEEDUP_EVERY));
}

/** Advance one tick. `jump` = the jump key was pressed since the last tick. */
function step(state, jump) {
  if (!state.alive) return state;

  if (jump && state.jumpT < 0) state.jumpT = 0;
  else if (state.jumpT >= 0) state.jumpT = state.jumpT + 1 >= ARC.length ? -1 : state.jumpT + 1;

  const speed = speedAt(state.tick);
  for (const o of state.obstacles) o.x -= speed;
  state.obstacles = state.obstacles.filter((o) => o.x + o.w > 0);

  state.nextSpawnIn -= speed;
  if (state.nextSpawnIn <= 0) {
    state.obstacles.push({ x: FIELD_W, w: 1 + state.rng.int(2), h: 1 + state.rng.int(2) });
    state.nextSpawnIn = MIN_GAP + state.rng.int(GAP_SPREAD);
  }

  const h = dinoHeight(state);
  for (const o of state.obstacles) {
    if (o.x <= DINO_X && DINO_X < o.x + o.w && h < o.h) {
      state.alive = false;
      break;
    }
  }

  state.tick += 1;
  if (state.alive) state.score = state.tick;
  return state;
}

/**
 * Run a whole game from a seed and the ticks at which jump was pressed.
 * Stops at death or `maxTicks`. The pure function behind every determinism test.
 */
function simulate(seed, jumpTicks = [], maxTicks = MAX_TICKS) {
  const jumps = new Set(jumpTicks);
  const state = create(seed);
  while (state.alive && state.tick < maxTicks) step(state, jumps.has(state.tick));
  return { score: state.score, ticks: state.tick, alive: state.alive, obstacles: state.obstacles.map((o) => ({ ...o })) };
}

/** Text frame: rows top→bottom, each FIELD_W wide. `ground` row last. */
function frame(state) {
  const rows = Array.from({ length: 4 }, () => Array(FIELD_W).fill(' '));
  const h = dinoHeight(state);
  const dinoRow = 3 - Math.min(3, h);
  rows[dinoRow][DINO_X] = state.alive ? '▲' : '✖';
  for (const o of state.obstacles) {
    for (let dx = 0; dx < o.w; dx++) {
      const x = o.x + dx;
      if (x < 0 || x >= FIELD_W) continue;
      for (let dy = 0; dy < o.h; dy++) rows[3 - dy][x] = '█';
    }
  }
  return [...rows.map((r) => r.join('')), '▔'.repeat(FIELD_W)];
}

function shareString(date, score) {
  return `Wait Runner ${date}\n🏃 ${score}m`;
}

module.exports = { FIELD_W, DINO_X, TICK_MS, MAX_TICKS, ARC, create, step, simulate, frame, dinoHeight, shareString };

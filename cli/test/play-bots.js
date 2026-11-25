'use strict';

/**
 * Tiny deterministic bots that PLAY the pure engines step by step and record the
 * input log, so tests can check replay(log) == live play. Shared by the cli and
 * api tests. Not a test file (no .test.js suffix).
 */

const snake = require('../src/play/snake');
const flappy = require('../src/play/flappy');
const blocks = require('../src/play/blocks');
const slide = require('../src/play/slide');
const chess = require('../src/play/chess');
const { makeRng } = require('../src/play/rng');

/** Greedy toward the food, never into a wall or its own body if it can help it. */
function snakeBot(seed, maxTicks = snake.MAX_TICKS) {
  const s = snake.create(seed);
  const log = [];
  const opposite = { u: 'd', d: 'u', l: 'r', r: 'l' };
  while (!s.over && s.tick < maxTicks) {
    const head = s.snake[0];
    const safe = (d) => {
      const x = head.x + snake.DIRS[d][0];
      const y = head.y + snake.DIRS[d][1];
      return x >= 0 && y >= 0 && x < snake.GRID_W && y < snake.GRID_H
        && !s.snake.slice(0, -1).some((c) => c.x === x && c.y === y);
    };
    const options = Object.keys(snake.DIRS).filter((d) => d !== opposite[s.dir] && safe(d));
    const dist = (d) => Math.abs(head.x + snake.DIRS[d][0] - s.food.x) + Math.abs(head.y + snake.DIRS[d][1] - s.food.y);
    options.sort((a, b) => dist(a) - dist(b));
    const turn = options.length && options[0] !== s.dir ? options[0] : null;
    if (turn) log.push([s.tick, turn]);
    snake.step(s, turn);
  }
  return { log, score: s.score, state: s };
}

/** Flap whenever the bird sinks below the middle of the next gap. */
function flappyBot(seed, maxTicks = flappy.MAX_TICKS) {
  const s = flappy.create(seed);
  const log = [];
  while (s.alive && s.tick < maxTicks) {
    const next = s.pipes.find((p) => p.x + flappy.PIPE_W > flappy.BIRD_X);
    const target = next ? (next.gapTop + flappy.GAP / 2) * flappy.SUB : 10 * flappy.SUB;
    const flap = s.y > target + 2 * flappy.SUB;
    if (flap) log.push(s.tick);
    flappy.step(s, flap);
  }
  return { log, score: s.score, state: s };
}

/** Random-but-seeded moves, hard-dropping now and then. */
function blocksBot(seed, ticks = 1500) {
  const s = blocks.create(seed);
  const rng = makeRng(seed ^ 0x9e3779b9);
  const log = [];
  while (!s.over && s.tick < ticks) {
    const acts = [];
    const n = rng.int(3);
    for (let i = 0; i < n; i++) acts.push(blocks.ACTIONS[rng.int(blocks.ACTIONS.length)]);
    for (const a of acts) log.push([s.tick, a]);
    blocks.step(s, acts);
  }
  return { log, score: s.score, state: s };
}

/** Cycle l,d,r,u and skip anything that changes nothing. */
function slideBot(seed, maxMoves = 400) {
  const s = slide.create(seed);
  const log = [];
  const order = ['l', 'd', 'r', 'u'];
  let i = 0;
  while (!s.over && s.moves < maxMoves) {
    for (let k = 0; k < 4; k++) {
      const d = order[(i + k) % 4];
      if (slide.move(s, d)) { log.push(d); i += k + 1; break; }
    }
  }
  return { log, score: s.score, state: s };
}

/** Play the listed solution through the real play() entry point. */
function chessBot(date) {
  const s = chess.create(date);
  const plies = s.solution.filter((_, i) => i % 2 === 0);
  for (const m of plies) if (!chess.play(s, m).ok || s.over) break;
  return { log: s.log.slice(), score: chess.score(s), state: s };
}

module.exports = { snakeBot, flappyBot, blocksBot, slideBot, chessBot };

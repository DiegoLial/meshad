'use strict';

/**
 * Session-level tests for the five newer games (snake, flappy, blocks, slide, chess):
 * picked from the session menu, driven by KEYS, frozen/resumed through the bridge,
 * and — the contract that matters — the live input log replays to the same score
 * through the engine's simulate/replay and through the API's own replayScore.
 * No TTY needed.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../src/play/bridge');
const term = require('../src/play/term');
const streak = require('../src/play/streak');
const arcadeViews = require('../src/play/views-arcade');
const snake = require('../src/play/snake');
const flappy = require('../src/play/flappy');
const blocks = require('../src/play/blocks');
const slide = require('../src/play/slide');
const chess = require('../src/play/chess');
const runner = require('../src/play/runner');
const lb = require('../src/leaderboard');
const { makeRng, seedFor } = require('../src/play/rng');
const { PlaySession, parseKeys, GAMES } = require('../src/play/session');
const apiGamesPath = path.join(__dirname, '..', '..', 'api', 'src', 'games.js');
const inMonorepo = fs.existsSync(apiGamesPath);
const replayScore = inMonorepo ? require(apiGamesPath).replayScore : null;
const { startMockServer } = require('./helpers/mock-server');
const { displayWidth } = require('../src/creative');

const DATE = '2026-11-24';
const NOW = Date.UTC(2026, 10, 24, 12);
const NEW_GAMES = ['snake', 'flappy', 'blocks', 'slide', 'chess'];
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-arcade-'));
const plain = term.makeStyle('none');
const make = (game, { dir = tmp(), clock = { t: NOW }, style = plain } = {}) => ({
  s: new PlaySession({ game, dir, now: () => clock.t, style }), dir, clock,
});
const keysOf = (s, ks) => { for (const k of ks) s.key(k); };

// ── bots that play through KEYS (they may only read the engine state, like a player reads the screen) ──

const KEY_OF = { u: 'up', d: 'down', l: 'left', r: 'right' };

function snakeKey(g) {
  const st = g.s;
  const head = st.snake[0];
  const opposite = { u: 'd', d: 'u', l: 'r', r: 'l' };
  const safe = (d) => {
    const x = head.x + snake.DIRS[d][0];
    const y = head.y + snake.DIRS[d][1];
    return x >= 0 && y >= 0 && x < snake.GRID_W && y < snake.GRID_H && !st.snake.slice(0, -1).some((c) => c.x === x && c.y === y);
  };
  const options = Object.keys(snake.DIRS).filter((d) => d !== opposite[st.dir] && safe(d));
  const dist = (d) => Math.abs(head.x + snake.DIRS[d][0] - st.food.x) + Math.abs(head.y + snake.DIRS[d][1] - st.food.y);
  options.sort((a, b) => dist(a) - dist(b));
  return options.length && options[0] !== st.dir ? KEY_OF[options[0]] : null;
}

function flappyKey(g) {
  const st = g.s;
  const next = st.pipes.find((p) => p.x + flappy.PIPE_W > flappy.BIRD_X);
  const target = next ? (next.gapTop + flappy.GAP / 2) * flappy.SUB : 10 * flappy.SUB;
  return st.y > target + 2 * flappy.SUB ? ' ' : null; // the same rule as test/play-bots.js
}

// ── menu, tick rates ────────────────────────────────────────────────────────

test('GAMES lists the seven games in picker order; the session menu starts each one by number', () => {
  assert.deepEqual(GAMES, ['runner', 'termo', 'snake', 'flappy', 'blocks', 'slide', 'chess']);
  GAMES.forEach((g, i) => {
    const { s } = make(null);
    s.key(String(i + 1));
    assert.equal(s.game, g);
  });
});

test('tick rate follows the game: each engine runs at its own TICK_MS (runner untouched)', () => {
  const rate = (g) => make(g).s.tickMs;
  assert.equal(rate('runner'), runner.TICK_MS);
  assert.equal(rate('snake'), snake.TICK_MS);
  assert.equal(rate('flappy'), flappy.TICK_MS);
  assert.equal(rate('blocks'), blocks.TICK_MS);
  assert.ok(rate('slide') > 0 && rate('chess') > 0 && rate('termo') > 0, 'turn-based games just redraw');
  const m = make(null).s;
  m.key('3');
  assert.equal(m.tickMs, snake.TICK_MS, 'switching games in the menu switches the rate');
});

// ── keys drive the engine; the live log replays ─────────────────────────────

/** The API replay (same code the server runs) must accept the log and reproduce the score. */
function assertServerReplays(result, game) {
  assert.ok(result, `${game}: finished game is scoreable`);
  assert.deepEqual([result.game, result.date], [game, DATE]);
  if (!inMonorepo) return; // public mirror has no apps/api
  const r = replayScore(game, DATE, result.log);
  assert.equal(r.ok, true, `${game}: ${r.message}`);
  assert.equal(r.score, result.score, `${game}: server replay score`);
}

test('snake: arrows / WASD / hjkl turn it; the key log replays to the same score', () => {
  const { s } = make('snake');
  assert.match(s.render(80, 24).join('\n'), /press an arrow key or Space to start/);
  s.tick();
  assert.equal(s.g.s.tick, 0, 'not started: no tick');
  s.key('up'); // an arrow starts it AND turns
  assert.equal(s.g.started, true);
  s.tick();
  assert.equal(s.g.s.dir, 'u');
  const turns = { w: 'u', a: 'l', s: 'd', d: 'r', k: 'u', h: 'l', j: 'd', l: 'r', left: 'l', right: 'r', up: 'u', down: 'd' };
  for (const [k, dir] of Object.entries(turns)) {
    const t = make('snake').s;
    t.key(' ');
    t.key(k); t.tick();
    // the first move is rightwards: a reverse turn (left) is ignored, everything else is taken
    assert.equal(t.g.s.dir, dir === 'l' ? 'r' : dir, `${k} → ${dir}`);
  }
  const bot = make('snake').s;
  bot.key(' ');
  while (!bot.g.over) {
    const k = snakeKey(bot.g);
    if (k) bot.key(k);
    bot.tick();
  }
  assert.ok(bot.g.over);
  assert.ok(bot.result.score >= 1, 'the bot ate something');
  assert.equal(bot.result.score, bot.g.s.score);
  assert.equal(snake.simulate(seedFor(DATE, 'snake'), bot.result.log).score, bot.result.score);
  assert.ok(bot.result.log.every((e, i, a) => Array.isArray(e) && e.length === 2 && Number.isInteger(e[0]) && (i === 0 || e[0] > a[i - 1][0])));
  assertServerReplays(bot.result, 'snake');
});

test('snake: two quick turns in one tick both happen (one per tick, in order)', () => {
  const { s } = make('snake');
  s.key(' ');
  s.key('up'); s.key('left'); // up now, left next tick
  s.tick(); s.tick();
  assert.equal(s.g.s.dir, 'l');
  assert.deepEqual(s.g.log().map((e) => e[1]), ['u', 'l']);
  assert.equal(s.g.log()[1][0], s.g.log()[0][0] + 1);
});

test('flappy: Space / Up flap, the first Space only starts; the key log replays', () => {
  const { s } = make('flappy');
  s.key('up');
  assert.equal(s.g.started, false, 'only Space starts');
  s.key(' ');
  assert.equal(s.g.started, true);
  const bot = make('flappy').s;
  bot.key(' ');
  while (!bot.g.over) {
    const k = flappyKey(bot.g);
    if (k) bot.key(bot.g.s.tick % 2 ? 'up' : ' ');
    bot.tick();
  }
  assert.ok(bot.g.over);
  assert.ok(bot.result, 'passed at least one pipe');
  assert.equal(bot.result.score, bot.g.s.score);
  assert.equal(flappy.simulate(seedFor(DATE, 'flappy'), bot.result.log).score, bot.result.score);
  assertServerReplays(bot.result, 'flappy');
});

test('blocks: ←→ move, ↑/x rotate cw, z ccw, ↓ soft, Space hard; the key log replays', () => {
  const { s } = make('blocks');
  assert.match(s.render(80, 26).join('\n'), /press Space to start/);
  s.key(' ');
  const x0 = s.g.s.cur.x;
  s.key('left'); s.tick();
  assert.equal(s.g.s.cur.x, x0 - 1);
  s.key('right'); s.key('right'); s.tick();
  assert.equal(s.g.s.cur.x, x0 + 1, 'several keys within one tick all apply');
  const rot = s.g.s.cur.rot;
  s.key('up'); s.tick();
  assert.equal(s.g.s.cur.rot, (rot + 1) % 4);
  s.key('z'); s.tick();
  assert.equal(s.g.s.cur.rot, rot);
  s.key('x'); s.tick();
  assert.equal(s.g.s.cur.rot, (rot + 1) % 4);
  const y0 = s.g.s.cur.y;
  s.key('down'); s.tick();
  assert.equal(s.g.s.cur.y, y0 + 1);
  assert.equal(s.g.s.score, 1, 'soft drop scores');
  const pieces = s.g.s.pieces;
  s.key(' '); s.tick();
  assert.equal(s.g.s.pieces, pieces + 1, 'hard drop locks at once');

  const rng = makeRng(7);
  const bot = make('blocks').s;
  bot.key(' ');
  while (!bot.g.over) {
    const r = rng.int(10);
    if (r === 0) bot.key('left'); else if (r === 1) bot.key('right'); else if (r === 2) bot.key('up'); else if (r === 3) bot.key('z');
    else if (r === 4) bot.key('s'); else if (r === 5) bot.key('d'); else if (r === 6 && bot.g.s.tick % 4 === 0) bot.key(' ');
    bot.tick();
  }
  assert.ok(bot.g.over);
  assert.ok(bot.result.score > 0);
  assert.equal(bot.result.score, bot.g.s.score);
  assert.equal(blocks.simulate(seedFor(DATE, 'blocks'), bot.result.log).score, bot.result.score);
  assertServerReplays(bot.result, 'blocks');
  assert.match(bot.shareText, /^Meshad Blocks 2026-11-24\n🧱 \d+ · \d+ lines$/);
});

test('slide: arrows / WASD / hjkl slide; an unchanged board is not a move and is not logged; Esc banks the score', () => {
  const { s, dir } = make('slide');
  const rng = makeRng(3);
  const dirs = ['left', 'right', 'up', 'down', 'w', 'a', 's', 'd', 'h', 'j', 'k', 'l'];
  let blocked = 0;
  for (let i = 0; i < 400 && !s.g.over && s.g.moves.length < 60; i++) {
    const before = s.g.moves.length;
    s.key(dirs[rng.int(dirs.length)]);
    if (s.g.moves.length === before) blocked += 1;
  }
  assert.equal(s.g.moves.length, 60);
  assert.ok(blocked > 0, 'some random keys changed nothing');
  assert.equal(s.g.s.moves, s.g.moves.length, 'only legal moves are in the log');
  assert.equal(s.result, null, 'still playing: nothing to submit yet');
  s.key('esc');
  assert.equal(s.done, true);
  assert.ok(s.result, 'Esc banks the score');
  assert.equal(slide.simulate(seedFor(DATE, 'slide'), s.result.log).score, s.result.score);
  assert.equal(s.result.score, s.g.s.score);
  assertServerReplays(s.result, 'slide');
  assert.equal(streak.load(dir).slide.best, s.result.score, 'recorded locally');
  assert.match(s.shareText, /^Slide 2026-11-24\n🔢 \d+ · best tile \d+$/);
});

test('slide: Esc on an untouched board banks nothing', () => {
  const { s, dir } = make('slide');
  s.key('esc');
  assert.equal(s.result, null);
  assert.equal(s.shareText, null);
  assert.equal(streak.load(dir).slide.played, 0);
});

test('chess: typed moves + Enter + Backspace drive the puzzle; the move log replays', () => {
  const { s, dir } = make('chess');
  const g = s.g;
  assert.match(s.render(80, 24).join('\n'), /find the mate in \d — you play (White|Black)/);
  keysOf(s, 'zz'); s.key('enter');
  assert.equal(g.s.log.length, 0);
  assert.match(s.render(80, 24).join('\n'), /not a move/);
  keysOf(s, 'a1a1'); s.key('enter');
  assert.match(s.render(80, 24).join('\n'), /illegal move/);
  keysOf(s, 'e2e4'); s.key('backspace'); s.key('backspace');
  assert.equal(g.buffer, 'e2');
  assert.match(s.render(80, 24).join('\n'), /move › e2_/);
  g.buffer = '';

  // a legal wrong move costs a life
  const wrong = chess.legalMoves(g.s.pos).map(chess.uci).find((u) => u !== g.s.solution[0] && !chess.isCheckmate(chess.makeMove(g.s.pos, chess.parseMove(g.s.pos, u))));
  keysOf(s, wrong); s.key('enter');
  assert.equal(g.s.mistakes, 1);
  assert.equal(g.lives, 2);
  assert.match(s.render(80, 24).join('\n'), /2 lives left/);
  assert.equal(s.barScore(), '2', 'score if solved from here');

  let guard = 0;
  while (!g.over && guard++ < 10) {
    const want = g.s.solution[g.s.idx];
    keysOf(s, want); s.key('enter');
  }
  assert.equal(g.s.solved, true);
  assert.equal(s.result.score, 2);
  assert.equal(chess.replay(DATE, s.result.log).score, 2);
  assertServerReplays(s.result, 'chess');
  assert.match(s.shareText, /^Mate Puzzle 2026-11-24 2\/3\n🟥🟩$/);
  assert.equal(streak.load(dir).chess.streak, 1);
  assert.match(s.render(80, 30).join('\n'), /checkmate! solved/);
});

test('chess: SAN works in lower case (nf3 → Nf3), x/+/# are not needed, three mistakes end it with no result', () => {
  const { s, dir } = make('chess');
  const g = s.g;
  const legal = chess.legalMoves(g.s.pos);
  const first = legal.find((m) => chess.uci(m) === g.s.solution[0]);
  const san = chess.toSan(g.s.pos, first, legal).replace(/[+#x=]/g, '').toLowerCase();
  keysOf(s, san); s.key('enter');
  assert.equal(g.s.log.length, 1, `SAN "${san}" accepted`);
  assert.equal(g.s.log[0], g.s.solution[0]);

  const f = make('chess', { dir }).s;
  const bad = chess.legalMoves(f.g.s.pos).map(chess.uci).filter((u) => u !== f.g.s.solution[0] && !chess.isCheckmate(chess.makeMove(f.g.s.pos, chess.parseMove(f.g.s.pos, u))));
  for (let i = 0; i < chess.MAX_MISTAKES; i++) { keysOf(f, bad[i]); f.key('enter'); }
  assert.equal(f.g.over, true);
  assert.equal(f.result, null, 'a failed puzzle is not submitted');
  assert.match(f.render(80, 24).join('\n'), /out of lives — the move was/);
  assert.equal(streak.load(dir).chess.streak, 0);
  assert.match(f.shareText, /^Mate Puzzle 2026-11-24 X\n🟥🟥🟥$/);
  keysOf(f, 'e2e4'); f.key('enter');
  assert.equal(f.g.s.log.length, chess.MAX_MISTAKES, 'nothing is accepted after the end');
  keysOf(f, 'r');
  assert.equal(f.g.s.over, true, 'R types a letter in chess, it does not restart the puzzle');
});

// ── pause / restart / quit ──────────────────────────────────────────────────

test('P pauses the real-time games (ticks and keys stop), R restarts, Esc quits everywhere', () => {
  for (const game of ['snake', 'flappy', 'blocks']) {
    const { s } = make(game);
    s.key(' ');
    s.tick(); s.tick();
    const t = s.g.s.tick;
    s.key('p');
    assert.equal(s.g.paused, true, game);
    s.key(' '); s.key('left'); s.tick(); s.tick();
    assert.equal(s.g.s.tick, t, `${game}: paused ticks do nothing`);
    assert.match(s.render(80, 26).join('\n'), /PAUSED/);
    s.key('p');
    s.tick();
    assert.equal(s.g.s.tick, t + 1, `${game}: resumes where it stopped`);
    s.key('r');
    assert.equal(s.g.s.tick, 0, `${game}: restart`);
    assert.equal(s.g.started, false);
  }
  for (const game of NEW_GAMES) {
    const { s } = make(game);
    s.key('esc');
    assert.equal(s.done, true, `${game}: Esc quits`);
  }
});

// ── freeze / resume through the bridge, exactly like the runner ─────────────

test('real-time games freeze when the agent answers, resume where they stopped, and Space keeps playing', () => {
  for (const game of ['snake', 'flappy', 'blocks']) {
    const { s, dir, clock } = make(game);
    s.key(' ');
    const ticks = (n) => { for (let i = 0; i < n; i++) s.tick(); return s.g.s.tick; };
    bridge.writeState(dir, 'waiting', clock.t); s.poll();
    assert.equal(s.gate, 'run');
    assert.equal(ticks(5), 5, game);
    bridge.writeState(dir, 'idle', clock.t); s.poll();
    assert.equal(s.gate, 'frozen');
    assert.equal(ticks(5), 5, `${game}: no progress while the agent is answering`);
    const frozen = s.render(80, 26).join('\n');
    assert.match(frozen.replace(/\s+/g, ''), /YOURANSWERISREADY/);
    assert.match(frozen, /Space to keep playing · Esc back to agent/);
    assert.match(frozen, new RegExp(`score ${s.g.score}`));
    s.key('left'); s.key('right');
    assert.equal(s.g.pending ? s.g.pending.length : 0, 0, `${game}: arrows are swallowed while frozen`);
    s.key(' ');
    assert.equal(s.override, true);
    assert.equal(ticks(3), 8, `${game}: free-play continues`);
    assert.doesNotMatch(s.render(80, 26).join('\n'), /ANSWER/);
    bridge.writeState(dir, 'waiting', clock.t); s.poll();
    assert.equal(s.override, false);
    bridge.writeState(dir, 'idle', clock.t); s.poll();
    assert.equal(ticks(4), 8);
    bridge.writeState(dir, 'waiting', clock.t); s.poll();
    assert.equal(ticks(2), 10, `${game}: resumes exactly where it stopped`);
  }
});

test('turn-based games (slide, chess) swallow moves while frozen; Space keeps playing', () => {
  const { s, dir, clock } = make('slide');
  bridge.writeState(dir, 'idle', clock.t); s.poll();
  const before = JSON.stringify(s.g.s.board);
  keysOf(s, ['left', 'up', 'right', 'down']);
  assert.equal(JSON.stringify(s.g.s.board), before, 'frozen: no moves');
  s.key(' ');
  assert.equal(s.gate, 'run');
  const moved = ['left', 'right', 'up', 'down'].some((k) => { s.key(k); return JSON.stringify(s.g.s.board) !== before; });
  assert.ok(moved);

  const c = make('chess', { dir: tmp(), clock });
  bridge.writeState(c.dir, 'idle', clock.t); c.s.poll();
  keysOf(c.s, 'e2e4'); c.s.key('enter');
  assert.equal(c.s.g.buffer, '', 'typing is swallowed');
  assert.equal(c.s.g.s.log.length, 0);
  c.s.key(' ');
  keysOf(c.s, 'ab');
  assert.equal(c.s.g.buffer, 'ab');
});

test('the leaderboard log is unchanged by freezing: only ticks that ran are in it', () => {
  const { s, dir, clock } = make('snake');
  s.key(' ');
  s.key('down'); s.tick();
  bridge.writeState(dir, 'idle', clock.t); s.poll();
  s.key('left'); s.tick(); s.tick(); // frozen: swallowed
  s.key(' '); // keep playing
  s.key('left'); s.tick();
  assert.deepEqual(s.g.log().map((e) => e[1]), ['d', 'l']);
  assert.deepEqual(s.g.log().map((e) => e[0]), [0, 1], 'frozen ticks never happened');
});

// ── rendering ───────────────────────────────────────────────────────────────

function driveSome(s, game) {
  if (game === 'chess') { keysOf(s, 'e2'); return; }
  if (game === 'slide') { keysOf(s, ['left', 'up', 'right', 'down']); return; }
  s.key(' ');
  for (let i = 0; i < 12; i++) {
    if (game === 'flappy' && i % 4 === 0) s.key(' ');
    if (game === 'snake' && i === 2) s.key('down');
    if (game === 'blocks' && i === 3) s.key('left');
    s.tick();
  }
}

test('every view fits 40–120 columns and the terminal rows, coloured and plain, before/during/after a game', () => {
  for (const game of NEW_GAMES) {
    for (const depth of ['none', '256', 'truecolor']) {
      for (const cols of [40, 52, 60, 80, 100, 120]) {
        for (const rows of [24, 30, 40]) {
          const style = term.makeStyle(depth);
          const { s } = make(game, { style });
          const check = (label) => {
            const out = s.render(cols, rows);
            assert.equal(out.length, rows, `${game}/${depth}/${cols}x${rows} ${label}: rows`);
            out.forEach((l, i) => {
              assert.ok(displayWidth(strip(l)) <= cols - 1, `${game}/${depth}/${cols}x${rows} ${label} row ${i} is ${displayWidth(strip(l))} wide: ${strip(l)}`);
              if (depth === 'none') assert.ok(!l.includes('\x1b'), 'NO_COLOR is plain');
            });
            return out;
          };
          check('fresh');
          driveSome(s, game);
          check('mid');
          for (let i = 0; i < 4000 && !s.g.over; i++) { if (game === 'snake' && i % 7 === 0) s.key(['down', 'left', 'up', 'right'][(i / 7) % 4]); if (game === 'blocks') s.key(' '); s.tick(); }
          if (game === 'slide' || game === 'chess') s.key('esc');
          check('end');
        }
      }
    }
  }
});

test('plain views still tell the pieces apart (NO_COLOR): snake @ o *, blocks letters + ghost, chess ♔ vs ♚, slide numbers', () => {
  const sn = make('snake').s;
  sn.key(' ');
  const snakeText = sn.render(80, 30).join('\n');
  assert.match(snakeText, /@@/);
  assert.match(snakeText, /oo/);
  assert.match(snakeText, /\*\*/);

  const bl = make('blocks').s;
  bl.key(' ');
  const text = bl.render(80, 30).join('\n');
  assert.match(text, new RegExp(`(${blocks.PIECES.join('|')}){2}`), 'piece letters');
  assert.match(text, /::/, 'ghost piece');
  assert.match(text, /NEXT/);
  assert.match(text, /SCORE/);

  const ch = make('chess').s;
  const board = ch.render(80, 24).join('\n');
  assert.match(board, /♔/);
  assert.match(board, /♚/);
  assert.match(board, /\[.\]/, 'last move is bracketed');
  assert.match(board, /a {2}b {2}c/, 'file coordinates');
  assert.match(board, /^1 /m);
  assert.match(board, /^8 /m);

  const sl = make('slide').s;
  assert.match(sl.render(80, 24).join('\n'), /\[ {2}2 {2}\]/);
});

test('coloured views: blocks has 7 distinct piece colours, a ghost and a next preview', () => {
  const style = term.makeStyle('truecolor');
  const { s } = make('blocks', { style });
  s.key(' ');
  // paint one of each piece into the board (rows 12..18), keep the live piece up top
  blocks.PIECES.forEach((_, i) => { s.g.s.board[19 - (i % 5)][i] = i + 1; s.g.s.board[19 - (i % 5)][9 - i % 3] = i + 1; });
  const out = s.render(80, 30).join('\n');
  const colours = Object.values(arcadeViews.PIECE_COLOR);
  assert.equal(new Set(colours).size, 7);
  for (const hex of colours) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(out.includes(`2;${r};${g};${b}`), `${hex} drawn`);
  }
  assert.match(strip(out), /NEXT/);
  assert.ok(out.includes('▀'), 'half-block pixels');
  const idle = blocks.create(1);
  const ghost = arcadeViews.blocksView({ s: idle, started: true }, { style, cols: 80, rows: 30, pulse: term.pulseFor(0) }).join('\n');
  const noGhost = arcadeViews.blocksView({ s: { ...idle, over: true }, started: true }, { style, cols: 80, rows: 30, pulse: term.pulseFor(0) }).join('\n');
  assert.notEqual(ghost, noGhost, 'the ghost is drawn while the piece falls');
});

test('coloured views: slide has a colour ramp per value; chess has light/dark squares and a last-move highlight', () => {
  const style = term.makeStyle('truecolor');
  const seen = new Set([2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048].map(arcadeViews.slideColor));
  assert.equal(seen.size, 11, 'every value gets its own colour');
  const { s } = make('slide', { style });
  s.g.s.board = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 0, 0, 0, 0, 4096];
  const out = s.render(80, 30).join('\n');
  for (const v of [2, 128, 2048, 4096]) assert.match(strip(out), new RegExp(`\\b${v}\\b`));
  assert.ok(new Set(out.match(/48;2;\d+;\d+;\d+m/g)).size >= 12, 'many distinct tile backgrounds');

  const c = make('chess', { style }).s;
  const text = c.render(80, 30).join('\n');
  assert.ok(text.includes('48;2;138;151;184m'), 'light squares');
  assert.ok(text.includes('48;2;86;99;138m'), 'dark squares');
  const last = c.g.s.lastMove;
  assert.ok(last, 'the opponent just moved');
  const files = 'abcdefgh';
  for (const sq of [last.slice(0, 2), last.slice(2, 4)]) {
    const f = files.indexOf(sq[0]);
    const rr = 8 - Number(sq[1]);
    const base = (f + rr) % 2 === 0 ? '#8a97b8' : '#56638a';
    assert.ok(text.includes(`48;2;${term.mix(base, 'amber', 0.5).join(';')}m`), `${sq} is highlighted`);
  }
  assert.ok(text.includes('♞') || text.includes('♜') || text.includes('♟'), 'pieces');
  assert.ok(text.includes('38;2;255;255;255'), 'white pieces');
});

test('chess flips the board for Black and keeps coordinates right', () => {
  let black = null;
  for (let d = 1; d <= 28 && !black; d++) {
    const date = `2026-12-${String(d).padStart(2, '0')}`;
    const g = chess.create(date);
    if (g.pos.turn === 'b') black = date;
  }
  assert.ok(black, 'some daily puzzle has Black to move');
  const s = new PlaySession({ game: 'chess', dir: tmp(), now: () => Date.parse(`${black}T12:00:00Z`), style: plain });
  const out = s.render(80, 24).join('\n');
  assert.match(out, /^1 /m);
  assert.match(out, /h {2}g {2}f {2}e/, 'files run h→a for Black');
  assert.match(out, /Black/);
});

test('wait pulse recolours every new game and shows in the status bar; it never changes the engine', () => {
  for (const game of NEW_GAMES) {
    const style = term.makeStyle('truecolor');
    const a = make(game, { style });
    const b = make(game, { style });
    driveSome(a.s, game); driveSome(b.s, game);
    const calm = a.s.render(80, 30);
    bridge.writeState(a.dir, 'waiting', a.clock.t); a.s.poll();
    a.clock.t += 55_000;
    bridge.writeState(a.dir, 'waiting', a.clock.t); a.s.poll();
    const hot = a.s.render(80, 30);
    assert.notDeepEqual(hot.slice(2, -1), calm.slice(2, -1), `${game}: the wait pulse recolours the scene`);
    assert.match(strip(hot.at(-1)), /thinking/);
    assert.match(strip(hot.at(-1)), /55s/);
    assert.deepEqual(JSON.stringify(a.s.g.s, (k, v) => (k === 'rng' ? undefined : v)), JSON.stringify(b.s.g.s, (k, v) => (k === 'rng' ? undefined : v)), `${game}: engine state identical`);
  }
});

// ── finish: streak, best, share card ────────────────────────────────────────

test('finishing records the local streak + best, shows a coloured share card, and the share text has no links', () => {
  for (const game of ['snake', 'flappy', 'blocks']) {
    const style = term.makeStyle('truecolor');
    const { s, dir } = make(game, { style });
    s.key(' ');
    for (let i = 0; i < 6000 && !s.g.over; i++) {
      if (game === 'snake') { const k = snakeKey(s.g); if (k) s.key(k); } else if (game === 'flappy') { if (flappyKey(s.g)) s.key(' '); } else if (i % 5 === 0) s.key(' ');
      s.tick();
    }
    assert.ok(s.finished, game);
    const e = streak.load(dir)[game];
    assert.equal(e.played, 1);
    assert.equal(e.streak, 1);
    assert.equal(e.best, s.g.score);
    assert.doesNotMatch(s.shareText, /https?:|www\.|\.com/i, 'text only, no links');
    const card = s.shareCardLines();
    assert.ok(card.length > 0);
    assert.match(strip(card.join('\n')), new RegExp(s.shareText.split('\n')[0]));
    assert.match(strip(card.join('\n')), /1-day streak/);
    assert.match(strip(s.render(80, 40).join('\n')), /game over/);
  }
});

test('a new best is flagged on the card; the next day continues the streak', () => {
  const dir = tmp();
  const day1 = make('slide', { dir, clock: { t: Date.UTC(2026, 10, 23, 12) } }).s;
  for (let i = 0; i < 40; i++) keysOf(day1, ['left', 'up', 'right', 'down']);
  day1.key('esc');
  const best = streak.load(dir).slide.best;
  assert.ok(best > 0);
  const day2 = make('slide', { dir, clock: { t: Date.UTC(2026, 10, 24, 12) } }).s;
  for (let i = 0; i < 80; i++) keysOf(day2, ['left', 'up', 'right', 'down']);
  day2.key('esc');
  assert.equal(streak.load(dir).slide.streak, 2);
  assert.ok(streak.load(dir).slide.best >= best);
});

// ── leaderboard client ──────────────────────────────────────────────────────

test('submit sends {game, date, score, log} in the exact format the API replays, for every new game', async () => {
  const mock = await startMockServer();
  const dir = tmp();
  try {
    await lb.join('neo_dev', { dir, apiUrl: mock.url });
    const results = {};
    const sn = make('snake').s; sn.key(' ');
    while (!sn.g.over) { const k = snakeKey(sn.g); if (k) sn.key(k); sn.tick(); }
    results.snake = sn.result;
    const fl = make('flappy').s; fl.key(' ');
    while (!fl.g.over) { if (flappyKey(fl.g)) fl.key(' '); fl.tick(); }
    results.flappy = fl.result;
    const bl = make('blocks').s; bl.key(' ');
    while (!bl.g.over) { if (bl.g.s.tick % 6 === 0) bl.key(' '); if (bl.g.s.tick % 6 === 3) bl.key('left'); bl.tick(); }
    results.blocks = bl.result;
    const sl = make('slide').s;
    for (let i = 0; i < 60; i++) keysOf(sl, ['left', 'up', 'right', 'down']);
    sl.key('esc');
    results.slide = sl.result;
    const ch = make('chess').s;
    for (let i = 0; i < 6 && !ch.g.over; i++) { keysOf(ch, ch.g.s.solution[ch.g.s.idx]); ch.key('enter'); }
    results.chess = ch.result;

    for (const game of NEW_GAMES) {
      const r = results[game];
      assertServerReplays(r, game);
      const res = await lb.submit(r, { dir, apiUrl: mock.url });
      assert.equal(res.accepted, true);
      const sent = mock.received.games.at(-1);
      assert.equal(sent.path, '/v1/games/scores');
      assert.deepEqual(Object.keys(sent.body).sort(), ['date', 'game', 'log', 'score']);
      assert.deepEqual(sent.body, { game, date: DATE, score: r.score, log: r.log });
    }
    assert.deepEqual(lb.GAMES, GAMES);
    await assert.rejects(lb.submit({ game: 'pong', date: DATE, score: 1, log: [] }, { dir, apiUrl: mock.url }), (e) => e.code === 'bad_result');
    await assert.rejects(lb.submit({ game: 'snake', date: DATE, score: 1.5, log: [] }, { dir, apiUrl: mock.url }), (e) => e.code === 'bad_result');
  } finally { await mock.close(); }
});

test('an unfinished or zero-score game has no result to submit', () => {
  for (const game of ['snake', 'flappy', 'blocks']) {
    const { s } = make(game);
    s.key(' ');
    for (let i = 0; i < 5; i++) s.tick();
    assert.equal(s.result, null, `${game}: still going`);
  }
  const f = make('flappy').s;
  f.key(' ');
  for (let i = 0; i < 200 && !f.g.over; i++) f.tick(); // falls to the floor without passing a pipe
  assert.equal(f.g.over, true);
  assert.equal(f.result, null, 'score 0 is not submitted');
});

test('no new file in play/ can reach the network, and none says the forbidden word', () => {
  const dir = path.join(__dirname, '..', 'src', 'play');
  for (const f of ['arcade.js', 'views-arcade.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /require\('(?:node:)?(?:https?|net|dgram|tls)'\)|\.\.\/net|fetch\(/);
  }
  const word = new RegExp(['t', 'e', 't', 'r', 'i', 's'].join(''), 'i'); // spelled out here would break the rule it checks
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|json|md|mjs)$/.test(e.name) && word.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  walk(path.join(__dirname, '..'));
  const apiSrc = path.join(__dirname, '..', '..', 'api', 'src');
  if (fs.existsSync(apiSrc)) walk(apiSrc);
  assert.deepEqual(hits, []);
});

// parseKeys is shared by every game
test('arrow escape sequences reach the games as named keys', () => {
  const { s } = make('snake');
  s.key(' ');
  for (const k of parseKeys('\x1b[A')) s.key(k);
  s.tick();
  assert.equal(s.g.s.dir, 'u');
});

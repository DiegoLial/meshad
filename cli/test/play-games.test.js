'use strict';

/**
 * Pure engines for the extra `meshad play` games: determinism, replay == live
 * play, bounds, game over, and each game's own mechanics.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { seedFor } = require('../src/play/rng');
const snake = require('../src/play/snake');
const flappy = require('../src/play/flappy');
const blocks = require('../src/play/blocks');
const slide = require('../src/play/slide');
const chess = require('../src/play/chess');
const bots = require('./play-bots');

const DATES = ['2026-11-24', '2026-11-25', '2026-12-01'];

// ------------------------------------------------------------------ snake

test('snake: same seed + log → same score; replay equals live play', () => {
  for (const d of DATES) {
    const seed = seedFor(d, 'snake');
    const live = bots.snakeBot(seed);
    assert.ok(live.score > 0);
    const a = snake.simulate(seed, live.log);
    const b = snake.simulate(seed, live.log);
    assert.deepEqual(a, b);
    assert.equal(a.score, live.score);
    assert.equal(a.ticks, live.state.tick);
  }
  assert.deepEqual(snake.create(seedFor(DATES[0], 'snake')).food, snake.create(seedFor(DATES[0], 'snake')).food, 'food is seeded');
});

test('snake: bounds, wall death, reversal ignored, cap', () => {
  const s = snake.create(1);
  assert.equal(s.snake.length, snake.START_LEN);
  snake.step(s, 'l'); // straight back into the neck: ignored
  assert.equal(s.dir, 'r');
  assert.equal(s.over, false);
  const r = snake.simulate(1, []); // runs right into the wall
  assert.equal(r.over, true);
  assert.equal(r.score, 0);
  assert.equal(snake.simulate(1, [], 3).over, true, 'cap reached counts as over');
  const live = bots.snakeBot(seedFor(DATES[0], 'snake'), 200);
  for (const c of live.state.snake) assert.ok(c.x >= 0 && c.x < snake.GRID_W && c.y >= 0 && c.y < snake.GRID_H);
  assert.ok(snake.MAX_SCORE < snake.GRID_W * snake.GRID_H);
});

test('snake: self-collision ends the game', () => {
  const s = snake.create(5);
  s.snake = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 }, { x: 4, y: 4 }, { x: 5, y: 4 }];
  s.dir = 'u';
  s.food = { x: 20, y: 10 };
  // head (5,5) turns left into (4,5): body
  snake.step(s, 'l');
  assert.equal(s.over, true);
  assert.equal(s.cause, 'self');
  // stepping onto the cell the tail is leaving is legal
  const t = snake.create(5);
  t.snake = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 }];
  t.dir = 'l';
  t.food = { x: 20, y: 10 };
  snake.step(t, 'd'); // head → (5,6), where the tail is leaving
  assert.equal(t.over, false);
});

test('snake: eating grows the snake and scores', () => {
  const s = snake.create(9);
  const h = s.snake[0];
  s.food = { x: h.x + 1, y: h.y };
  snake.step(s, null);
  assert.equal(s.score, 1);
  assert.equal(s.snake.length, snake.START_LEN + 1);
  assert.ok(!s.snake.some((c) => c.x === s.food.x && c.y === s.food.y), 'food spawns on a free cell');
});

// ----------------------------------------------------------------- flappy

test('flappy: same seed + log → same score; replay equals live play', () => {
  for (const d of DATES) {
    const seed = seedFor(d, 'flappy');
    const live = bots.flappyBot(seed);
    assert.ok(live.score > 0);
    const a = flappy.simulate(seed, live.log);
    assert.deepEqual(a, flappy.simulate(seed, live.log));
    assert.equal(a.score, live.score);
    assert.ok(Number.isInteger(live.state.y) && Number.isInteger(live.state.vy), 'integer fixed-point physics');
  }
});

test('flappy: passing a pipe scores, no input falls to the floor, bounds', () => {
  const idle = flappy.simulate(seedFor(DATES[0], 'flappy'), []);
  assert.equal(idle.score, 0);
  assert.equal(idle.alive, false);
  assert.ok(idle.ticks < 40);
  const s = flappy.create(3);
  s.pipes = [{ x: flappy.BIRD_X + 1, gapTop: 8, passed: false }];
  s.y = 10 * flappy.SUB;
  s.nextSpawnIn = 99;
  for (let i = 0; i < flappy.PIPE_W + 2 && s.alive; i++) flappy.step(s, false);
  assert.equal(s.alive, true);
  assert.equal(s.score, 1);
  // hitting a pipe wall kills
  const w = flappy.create(3);
  w.pipes = [{ x: flappy.BIRD_X, gapTop: 14, passed: false }];
  w.nextSpawnIn = 99;
  flappy.step(w, false);
  assert.equal(w.alive, false);
  assert.ok(flappy.MAX_SCORE >= bots.flappyBot(seedFor(DATES[1], 'flappy')).score);
  for (const p of bots.flappyBot(seedFor(DATES[1], 'flappy')).state.pipes) assert.ok(p.gapTop >= 2 && p.gapTop + flappy.GAP <= flappy.FIELD_H - 1);
});

// ----------------------------------------------------------------- blocks

test('blocks: same seed + log → same score; replay equals live play', () => {
  for (const d of DATES) {
    const seed = seedFor(d, 'blocks');
    const live = bots.blocksBot(seed);
    assert.ok(live.score > 0);
    const a = blocks.simulate(seed, live.log, blocks.MAX_TICKS);
    assert.deepEqual(a, blocks.simulate(seed, live.log, blocks.MAX_TICKS));
    assert.equal(a.score, live.score);
    assert.equal(a.lines, live.state.lines);
  }
});

test('blocks: seeded 7-bag, board bounds, rotation keeps 4 cells in range', () => {
  const s = blocks.create(seedFor(DATES[0], 'blocks'));
  const seq = [s.cur.type, ...s.queue.slice(0, 6)];
  assert.deepEqual([...seq].sort(), [...blocks.PIECES].sort(), 'first 7 pieces are one bag');
  assert.deepEqual(blocks.create(seedFor(DATES[0], 'blocks')).cur, s.cur);
  assert.equal(s.board.length, blocks.BOARD_H);
  for (const type of blocks.PIECES) {
    for (let rot = 0; rot < 4; rot++) {
      assert.equal(new Set(blocks.SHAPES[type][rot].map((c) => c.join())).size, 4);
    }
  }
  for (const a of ['cw', 'cw', 'ccw', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'r', 'soft']) {
    blocks.step(s, [a]);
    for (const [x, y] of blocks.cellsOf(s.cur)) assert.ok(x >= 0 && x < blocks.BOARD_W && y < blocks.BOARD_H);
  }
  // wall kick: rotate a vertical I hugging the wall
  const k = blocks.create(7);
  k.cur = { type: 'I', rot: 1, x: -2, y: 5 }; // vertical, cells at column x+2 = 0
  assert.ok(!blocks.collides(k.board, k.cur));
  blocks.step(k, ['cw']);
  assert.equal(k.cur.rot, 2, 'rotation succeeded');
  assert.ok(!blocks.collides(k.board, k.cur));
});

test('blocks: line clear, drop points, level speeds gravity, game over', () => {
  const s = blocks.create(11);
  s.board[blocks.BOARD_H - 1] = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0];
  s.cur = { type: 'I', rot: 0, x: 6, y: 0 }; // horizontal I, cells in row y+1
  blocks.step(s, ['hard']);
  assert.equal(s.lines, 1);
  assert.equal(s.board[blocks.BOARD_H - 1].every((c) => c === 0), true, 'row cleared');
  assert.equal(s.score, 100 + 2 * 18, '100 per single at level 0 + 2 per hard-dropped row');
  // four rows at once pay 800 × (level + 1)
  const q = blocks.create(11);
  for (let r = 16; r < 20; r++) q.board[r] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
  q.cur = { type: 'I', rot: 1, x: 7, y: 0 }; // vertical I in column 9
  blocks.step(q, ['hard']);
  assert.equal(q.lines, 4);
  assert.equal(q.score, 800 + 2 * 16);
  // soft drop = +1 per row
  const d = blocks.create(11);
  blocks.step(d, ['soft', 'soft']);
  assert.equal(d.score, 2);
  // gravity speeds up with level
  assert.ok(blocks.GRAVITY_TICKS.every((t, i, a) => i === 0 || t <= a[i - 1]));
  const lv = blocks.create(11);
  lv.board[19] = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0];
  lv.lines = 9;
  lv.cur = { type: 'I', rot: 0, x: 6, y: 0 };
  blocks.step(lv, ['hard']);
  assert.equal(lv.level, 1);
  assert.equal(lv.dropIn, blocks.GRAVITY_TICKS[1]);
  // stacking without clearing tops out
  const o = blocks.create(2);
  for (let i = 0; i < 40 && !o.over; i++) blocks.step(o, ['hard']);
  assert.equal(o.over, true);
  const frozen = o.tick;
  blocks.step(o, ['l']);
  assert.equal(o.tick, frozen, 'no ticks after game over');
});

// ------------------------------------------------------------------ slide

test('slide: same seed + log → same score; replay equals live play', () => {
  for (const d of DATES) {
    const seed = seedFor(d, 'slide');
    const live = bots.slideBot(seed);
    assert.ok(live.score > 0);
    const a = slide.simulate(seed, live.log);
    assert.deepEqual(a, slide.simulate(seed, live.log));
    assert.equal(a.score, live.score);
    assert.equal(a.illegal, 0);
    assert.equal(a.consumed, live.log.length);
  }
});

test('slide: merge rules', () => {
  const m = (l) => slide.slideLine(l);
  assert.deepEqual(m([2, 2, 2, 2]), { line: [4, 4, 0, 0], gained: 8 });
  assert.deepEqual(m([2, 2, 4, 0]), { line: [4, 4, 0, 0], gained: 4 });
  assert.deepEqual(m([4, 2, 2, 0]), { line: [4, 4, 0, 0], gained: 4 });
  assert.deepEqual(m([2, 0, 2, 4]), { line: [4, 4, 0, 0], gained: 4 });
  assert.deepEqual(m([2, 2, 2, 0]), { line: [4, 2, 0, 0], gained: 4 }, 'leading pair merges first');
  assert.deepEqual(m([4, 4, 8, 0]), { line: [8, 8, 0, 0], gained: 8 }, 'a fresh tile does not merge again');
  assert.deepEqual(m([2, 4, 2, 4]), { line: [2, 4, 2, 4], gained: 0 });
  const s = slide.create(3);
  s.board = [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(slide.move(s, 'l'), true);
  assert.equal(s.board[0], 4);
  assert.equal(s.score, 4);
  assert.equal(s.board.filter((v) => v).length, 2, 'one tile spawned after the move');
  s.board = [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(slide.move(s, 'l'), false, 'a move that changes nothing is refused');
  assert.equal(s.moves, 1);
  s.board = [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0];
  slide.move(s, 'u');
  assert.equal(s.board[3], 4, 'columns merge upward');
});

test('slide: game over when nothing can move; spawns are seeded', () => {
  const s = slide.create(4);
  s.board = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 0];
  assert.equal(slide.canMove(s.board), true);
  s.board[15] = 8; // full, no equal neighbours
  assert.equal(slide.canMove(s.board), false);
  assert.deepEqual(slide.create(77).board, slide.create(77).board);
  assert.equal(slide.create(77).board.filter((v) => v).length, 2);
  s.over = true;
  assert.equal(slide.move(s, 'l'), false);
});

// ------------------------------------------------------------------ chess

const POS = (fen) => chess.parseFen(fen);

test('chess: move generator passes perft (castling, en passant, promotion)', () => {
  assert.equal(chess.perft(POS(chess.START_FEN), 3), 8902);
  assert.equal(chess.perft(POS('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'), 3), 97862);
  assert.equal(chess.perft(POS('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'), 4), 43238);
  assert.equal(chess.perft(POS('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1'), 3), 9467);
});

test('chess: specific rules — mate, stalemate, castling, en passant, promotion', () => {
  assert.equal(chess.isCheckmate(POS('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3')), true, 'fool\'s mate');
  assert.equal(chess.isStalemate(POS('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')), true);
  const castle = POS('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const ucis = chess.legalMoves(castle).map(chess.uci);
  assert.ok(ucis.includes('e1g1') && ucis.includes('e1c1'));
  const after = chess.makeMove(castle, chess.parseMove(castle, 'e1g1'));
  assert.equal(after.board[61], 'R');
  assert.ok(!after.castle.includes('K') && !after.castle.includes('Q'));
  // cannot castle through an attacked square
  assert.ok(!chess.legalMoves(POS('r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1')).map(chess.uci).includes('e1g1'));
  // en passant
  const ep = POS('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  const m = chess.parseMove(ep, 'e5f6');
  assert.equal(m.flag, 'ep');
  assert.equal(chess.makeMove(ep, m).board[29], null, 'captured pawn on f5 removed');
  // promotion needs a piece letter; SAN works
  const pr = POS('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  assert.equal(chess.parseMove(pr, 'a7a8'), null);
  assert.equal(chess.uci(chess.parseMove(pr, 'a7a8q')), 'a7a8q');
  assert.equal(chess.uci(chess.parseMove(pr, 'a8=N')), 'a7a8n');
  assert.equal(chess.uci(chess.parseMove(castle, 'O-O')), 'e1g1');
  assert.equal(chess.parseMove(castle, 'e1e5'), null);
  // pinned piece may not move
  assert.ok(!chess.legalMoves(POS('4r3/8/8/8/8/8/4B3/4K2k w - - 0 1')).map(chess.uci).some((u) => u.startsWith('e2') && u[2] !== 'e'));
  // toFen round-trips
  assert.equal(chess.toFen(POS(chess.START_FEN)), chess.START_FEN);
});

test('chess: every bundled puzzle is legal and its listed solution ends in checkmate', () => {
  assert.ok(chess.PUZZLES.length >= 20);
  const ids = new Set();
  for (const p of chess.PUZZLES) {
    assert.ok(!ids.has(p.id), `duplicate ${p.id}`);
    ids.add(p.id);
    let pos = chess.parseFen(p.fen);
    p.moves.forEach((mv, i) => {
      const m = chess.parseMove(pos, mv);
      assert.ok(m, `${p.id}: move ${i} ${mv} is legal`);
      pos = chess.makeMove(pos, m);
    });
    assert.equal(chess.isCheckmate(pos), true, `${p.id} ends in mate`);
  }
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/play/chess-puzzles.json'), 'utf8'));
  assert.match(data.source, /database\.lichess\.org, CC0/);
});

test('chess: daily puzzle is seeded, play flow, scoring and replay', () => {
  for (const d of DATES) assert.equal(chess.dailyPuzzle(d).id, chess.dailyPuzzle(d).id);
  const date = DATES[0];
  const live = bots.chessBot(date);
  assert.equal(live.score, chess.MAX_SCORE);
  assert.deepEqual(chess.replay(date, live.log), { score: 3, over: true, solved: true, mistakes: 0, rejected: 0 });

  const s = chess.create(date);
  assert.equal(chess.play(s, 'zz').reason, 'unparsable');
  assert.equal(chess.play(s, 'a1a1').reason, 'illegal');
  assert.equal(s.log.length, 0, 'illegal input changes nothing');
  // pick a legal move that is neither the listed one nor mate → mistake
  const wrong = chess.legalMoves(s.pos).map(chess.uci).find((u) => u !== s.solution[0] && !chess.isCheckmate(chess.makeMove(s.pos, chess.parseMove(s.pos, u))));
  assert.equal(chess.play(s, wrong).result, 'mistake');
  assert.equal(s.mistakes, 1);
  assert.equal(chess.play(s, s.solution[0]).ok, true);
  if (!s.over) {
    let n = 0;
    while (!s.over && n++ < 20) chess.play(s, chess.legalMoves(s.pos).map(chess.uci).find((u) => u !== s.solution[s.idx]));
  }
  const r = chess.replay(date, s.log);
  assert.equal(r.score, chess.score(s));
  assert.equal(r.over, s.over);

  // too many mistakes → failed, score 0, nothing accepted after
  const f = chess.create(date);
  const bad = chess.legalMoves(f.pos).map(chess.uci).filter((u) => u !== f.solution[0] && !chess.isCheckmate(chess.makeMove(f.pos, chess.parseMove(f.pos, u))));
  let last;
  for (let i = 0; i < chess.MAX_MISTAKES; i++) last = chess.play(f, bad[i]);
  assert.equal(last.result, 'failed');
  assert.equal(chess.score(f), 0);
  assert.equal(chess.play(f, f.solution[0]).reason, 'over');
  assert.equal(chess.replay(date, [...f.log, f.solution[0]]).rejected, 1);
});

test('chess: any mating move solves the puzzle, even an unlisted one', () => {
  // Doubled rooks vs a back rank: Ra8# is listed, Rb8# also mates.
  const p = { id: 'x', rating: 1, themes: 'mate', fen: '6k1/3p1ppp/8/8/8/8/2K5/RR6 b - - 0 1', moves: ['d7d6', 'a1a8'] };
  const listed = chess.fromPuzzle(p);
  assert.equal(chess.play(listed, 'Ra8').result, 'solved');
  const alt = chess.fromPuzzle(p);
  assert.equal(chess.play(alt, 'b1b8').result, 'solved');
  assert.equal(alt.solved && chess.score(alt), 3);
});

// ------------------------------------------------------------------ misc

test('the new modules and tests never use the forbidden trademark word', () => {
  const word = new RegExp(['tet', 'ris'].join(''), 'i');
  const dir = path.join(__dirname, '../src/play');
  for (const f of ['snake', 'flappy', 'blocks', 'slide', 'chess'].map((n) => path.join(dir, `${n}.js`))
    .concat(path.join(dir, 'chess-puzzles.json'), __filename, path.join(__dirname, 'play-bots.js'))) {
    assert.ok(!word.test(fs.readFileSync(f, 'utf8')), `${path.basename(f)} is clean`);
  }
  let diff = '';
  try { diff = execFileSync('git', ['diff', 'main', '--', '.', '../api'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 }); } catch { /* no git: file scan above is enough */ }
  assert.ok(!word.test(diff), 'the diff is clean');
});

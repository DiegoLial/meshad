'use strict';

/**
 * Pure views for snake, flappy, blocks, slide and chess: game state → styled
 * lines (never wider than `cols - 1`). Cosmetic only, like views.js: nothing
 * here feeds back into an engine. Colour comes from the shared palette; at
 * depth 'none' every view falls back to plain glyphs that still tell the pieces
 * apart (@ o * for snake, I O T S Z J L for blocks, ♔ vs ♚ for chess).
 */

const flappy = require('./flappy');
const blocks = require('./blocks');
const chess = require('./chess');
const { Framebuffer, heatColor, mix, rgbOf } = require('./term');

const same = (a, b) => String(a) === String(b);
const center = (s, w) => {
  const str = String(s);
  const left = Math.max(0, Math.floor((w - str.length) / 2));
  return ' '.repeat(left) + str + ' '.repeat(Math.max(0, w - str.length - left));
};

/** Wrap `lines` (each exactly `innerW` wide) in a rounded box. */
function frame(lines, innerW, style, color) {
  const edge = (s) => style.paint(s, { fg: color });
  return [edge(`╭${'─'.repeat(innerW)}╮`), ...lines.map((l) => `${edge('│')}${l}${edge('│')}`), edge(`╰${'─'.repeat(innerW)}╯`)];
}

/**
 * Draw a grid of cells. cells[y][x] is null or {c: colour, g: plain glyph}.
 * Colour: a cell is `cw` columns wide and one text row tall, or — `half` — half
 * a row (two grid rows per text row, ▀ with fg=top bg=bottom). Plain: glyphs.
 */
function cellLines({ cells, w, h, style, cw, half, bgAt, bgGlyph = ' ' }) {
  const out = [];
  if (!style.on) {
    for (let y = 0; y < h; y++) {
      let row = '';
      for (let x = 0; x < w; x++) row += cells[y][x] ? cells[y][x].g.repeat(cw) : bgGlyph.padEnd(cw);
      out.push(row);
    }
    return out;
  }
  const colorAt = (x, y) => (y < h && cells[y][x] ? cells[y][x].c : bgAt(x, y));
  for (let y = 0; y < h; y += half ? 2 : 1) {
    let row = '';
    for (let x = 0; x < w; x++) {
      const top = colorAt(x, y);
      const bot = half ? colorAt(x, y + 1) : top;
      row += same(top, bot) ? style.paint(' '.repeat(cw), { bg: top }) : style.paint('▀'.repeat(cw), { fg: top, bg: bot });
    }
    out.push(row);
  }
  return out;
}

const emptyGrid = (w, h) => Array.from({ length: h }, () => Array(w).fill(null));

// ── snake ───────────────────────────────────────────────────────────────────

/**
 * Snake on its fixed 24×14 grid. Wide terminals draw two columns per cell (square cells);
 * narrow or short ones fall back to half-block pixels (24 columns, 7 rows).
 * @param {object} game  arcade SnakeGame (read only)
 */
function snakeView(game, { style, cols, rows, pulse }) {
  const s = game.s;
  const W = 24;
  const H = 14;
  const big = cols >= 54;
  const cw = big ? 2 : 1;
  const half = style.on && !(big && rows >= 24);
  const base = heatColor(game.started ? pulse.t : 0);
  const alt = mix(base, '#ffffff', 0.05);
  const cells = emptyGrid(W, H);
  const dead = s.over && !s.won;
  if (s.food) cells[s.food.y][s.food.x] = { c: (s.tick >> 2) & 1 ? 'red' : 'amber', g: '*' };
  const n = s.snake.length;
  for (let i = n - 1; i >= 1; i--) {
    const c = mix('green', '#0b3a2a', Math.min(0.6, (i / n) * 0.6));
    cells[s.snake[i].y][s.snake[i].x] = { c: dead ? mix(c, 'red', 0.5) : c, g: 'o' };
  }
  cells[s.snake[0].y][s.snake[0].x] = { c: dead ? 'red' : 'lime', g: '@' };
  const lines = cellLines({ cells, w: W, h: H, style, cw, half, bgAt: (x, y) => ((x + y) & 1 ? alt : base), bgGlyph: '·' });
  return frame(lines, W * cw, style, pulse.accent);
}

// ── flappy ──────────────────────────────────────────────────────────────────

const hash = (n) => {
  let x = Math.imul(n ^ 61, 0x27d4eb2d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x2c1b3c6d) >>> 0;
  return (x ^ (x >>> 12)) >>> 0;
};

/** Flappy: the 40×20 field as half-block pixels (40 columns × 10 rows, square pixels). */
function flappyView(game, { style, cols, pulse }) {
  const s = game.s;
  const w = Math.max(10, Math.min(flappy.FIELD_W, cols - 1));
  const sky = heatColor(game.started ? pulse.t : 0);
  const fb = new Framebuffer(w, flappy.FIELD_H / 2, { bg: sky });
  if (style.on) {
    const drift = Math.floor(s.tick / 3);
    for (let x = 0; x < w; x++) {
      for (let py = 0; py < flappy.FIELD_H; py++) if (hash((x + drift) * 31 + py * 7) % 61 === 0) fb.px(x, py, mix(sky, 'mute', 0.6));
    }
  }
  const pipe = mix('green', '#0b3a2a', 0.25);
  for (const p of s.pipes) {
    for (let dx = 0; dx < flappy.PIPE_W; dx++) {
      const x = p.x + dx;
      if (x < 0 || x >= w) continue;
      for (let py = 0; py < flappy.FIELD_H; py++) {
        if (py >= p.gapTop && py < p.gapTop + flappy.GAP) continue;
        const cap = py === p.gapTop - 1 || py === p.gapTop + flappy.GAP;
        fb.px(x, py, cap ? 'lime' : dx === 0 ? mix(pipe, '#000000', 0.25) : pipe);
      }
    }
  }
  const row = flappy.birdRow(s);
  if (row >= 0 && row < flappy.FIELD_H) {
    if (style.on) {
      const alive = s.alive;
      fb.px(flappy.BIRD_X - 1, row, alive ? mix('gold', '#000000', 0.3) : 'red'); // wing
      fb.px(flappy.BIRD_X, row, alive ? 'gold' : 'red'); // body
      fb.px(flappy.BIRD_X + 1, row, alive ? 'red' : 'ink'); // beak
    } else {
      fb.text(flappy.BIRD_X, row >> 1, s.alive ? '@' : 'X');
    }
  }
  if (s.score > 0) fb.text(Math.max(0, Math.floor(w / 2) - 1), 0, ` ${s.score} `, { fg: 'ink', bold: true });
  return fb.toLines(style);
}

// ── blocks ──────────────────────────────────────────────────────────────────

const PIECE_COLOR = { I: '#00e5ff', O: '#f5c518', T: '#b45cff', S: '#3ddc84', Z: '#ff4d5e', J: '#4c7dff', L: '#ff8c1a' };

/** Blocks: 10×20 board (two columns per cell, half-block rows), ghost piece, next-piece preview and a stats panel. */
function blocksView(game, { style, cols, rows, pulse, t = (k) => k }) {
  const s = game.s;
  const { BOARD_W: W, BOARD_H: H } = blocks;
  const base = heatColor(game.started ? pulse.t : 0);
  const alt = mix(base, '#ffffff', 0.05);
  const cells = emptyGrid(W, H);
  s.board.forEach((r, y) => r.forEach((v, x) => {
    if (v) cells[y][x] = { c: PIECE_COLOR[blocks.PIECES[v - 1]], g: blocks.PIECES[v - 1] };
  }));
  if (!s.over && s.cur) {
    const color = PIECE_COLOR[s.cur.type];
    const gy = blocks.dropY(s);
    for (const [x, y] of blocks.cellsOf({ ...s.cur, y: gy })) if (y >= 0 && !cells[y][x]) cells[y][x] = { c: mix(color, base, 0.7), g: ':' };
    for (const [x, y] of blocks.cellsOf(s.cur)) if (y >= 0) cells[y][x] = { c: color, g: s.cur.type };
  }
  const boardLines = cellLines({ cells, w: W, h: H, style, cw: 2, half: true, bgAt: (x, y) => ((x + y) & 1 ? alt : base), bgGlyph: '.' });
  const boxed = style.on || rows >= 28 ? frame(boardLines, W * 2, style, pulse.accent) : boardLines;
  const boardW = W * 2 + (style.on || rows >= 28 ? 2 : 0);

  const next = s.queue[0] || null;
  const prev = emptyGrid(4, 2);
  if (next) for (const [x, y] of blocks.SHAPES[next][0]) if (y < 2) prev[y][x] = { c: PIECE_COLOR[next], g: next };
  const nextLines = cellLines({ cells: prev, w: 4, h: 2, style, cw: 2, half: false, bgAt: () => base, bgGlyph: ' ' });
  const label = (str) => style.paint(str, { fg: 'mute', bold: true });
  const val = (str) => style.paint(str, { fg: 'ink', bold: true });
  const panel = [
    label(t('play.blocks.next')), ...nextLines, '',
    label(t('play.blocks.score')), val(String(s.score)), '',
    `${label(t('play.blocks.lines'))} ${val(String(s.lines))}`,
    `${label(t('play.blocks.level'))} ${val(String(s.level))}`,
  ];
  if (cols - 1 < boardW + 2 + 13) return boxed;
  const top = boxed.length > boardLines.length ? 1 : 0;
  return boxed.map((l, i) => (panel[i - top] !== undefined && i >= top ? `${l}  ${panel[i - top]}` : l));
}

// ── slide ───────────────────────────────────────────────────────────────────

const SLIDE_RAMP = ['#3a6ea5', '#2f8fbf', '#1fb5a4', '#3ddc84', '#9be04a', '#f5c518', '#ffa11a', '#ff7043', '#ff4d5e', '#e63aa8', '#b45cff', '#f0f4ff'];
const slideColor = (v) => SLIDE_RAMP[Math.min(SLIDE_RAMP.length - 1, Math.max(0, Math.round(Math.log2(v)) - 1))];
const luma = (c) => { const [r, g, b] = rgbOf(c); return 0.299 * r + 0.587 * g + 0.114 * b; };

/** Slide: 4×4 tiles, a colour ramp per value (2 → 4096+), taller tiles when the terminal has the rows. */
function slideView(game, { style, rows, pulse }) {
  const board = game.s.board;
  const SIZE = 4;
  const tw = 7;
  const th = style.on ? (rows >= 27 ? 3 : rows >= 21 ? 2 : 1) : 1;
  const gapRows = th > 1 ? 1 : 0;
  const base = heatColor(game.started ? pulse.t : 0);
  const empty = mix('#2a3358', base, 0.5);
  const lines = [];
  for (let r = 0; r < SIZE; r++) {
    for (let k = 0; k < th; k++) {
      let row = '';
      for (let c = 0; c < SIZE; c++) {
        const v = board[r * SIZE + c];
        const label = v ? String(v) : style.on ? '' : '·';
        if (!style.on) { row += `[${center(label, tw - 2)}]`; continue; }
        const bg = v ? slideColor(v) : empty;
        const txt = k === Math.floor(th / 2) ? center(label, tw) : ' '.repeat(tw);
        row += style.paint(txt, { fg: v && luma(bg) > 150 ? 'night' : 'ink', bg, bold: true });
        if (c < SIZE - 1) row += style.paint(' ', { bg: base });
      }
      lines.push(style.on ? row : row.replace(/\]\[/g, '] ['));
    }
    if (gapRows && r < SIZE - 1) lines.push(style.paint(' '.repeat(SIZE * tw + SIZE - 1), { bg: base }));
  }
  const innerW = SIZE * tw + (SIZE - 1);
  return style.on ? frame(lines, innerW, style, pulse.accent) : lines;
}

// ── chess ───────────────────────────────────────────────────────────────────

const FILLED = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const OUTLINE = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' };
const FILES = 'abcdefgh';
const sqIdx = (sq) => (8 - Number(sq[1])) * 8 + FILES.indexOf(sq[0]);
const LIGHT = '#8a97b8';
const DARK = '#56638a';

/**
 * Chess: board with the player's side at the bottom, coordinates, last-move and check
 * highlights, lives, and the move input line. `t` supplies the one info string.
 */
function chessView(game, { style, rows, pulse, t = (k) => k }) {
  const s = game.s;
  const pos = s.pos;
  const flip = game.side === 'b';
  const th = style.on && rows >= 24 ? 2 : 1;
  const last = s.lastMove ? [sqIdx(s.lastMove.slice(0, 2)), sqIdx(s.lastMove.slice(2, 4))] : [];
  const kingAt = chess.inCheck(pos) ? pos.board.indexOf(pos.turn === 'w' ? 'K' : 'k') : -1;
  const hearts = style.paint('♥'.repeat(game.lives), { fg: 'red' }) + style.paint('♡'.repeat(chess.MAX_MISTAKES - game.lives), { fg: 'line' });
  const side = game.side === 'w' ? t('play.chess.white') : t('play.chess.black');
  const out = [`  ${hearts}  ${style.paint(t('play.chess.info', { n: s.mateIn, side }), { fg: 'mute' })}`];
  for (let r = 0; r < 8; r++) {
    for (let k = 0; k < th; k++) {
      let row = style.paint(k === 0 ? `${flip ? r + 1 : 8 - r} ` : '  ', { fg: 'mute' });
      for (let c = 0; c < 8; c++) {
        const i = flip ? (7 - r) * 8 + (7 - c) : r * 8 + c;
        const piece = pos.board[i];
        const lightSq = ((i & 7) + (i >> 3)) % 2 === 0;
        const moved = last.includes(i);
        if (!style.on) {
          const glyph = piece ? (piece < 'a' ? OUTLINE[piece] : FILLED[piece]) : lightSq ? ' ' : '·';
          row += moved ? `[${glyph}]` : ` ${glyph} `;
          continue;
        }
        let bg = lightSq ? LIGHT : DARK;
        if (moved) bg = mix(bg, 'amber', 0.5);
        if (i === kingAt) bg = mix(bg, 'red', 0.65);
        const glyph = piece && k === 0 ? FILLED[piece.toLowerCase()] : ' ';
        row += style.paint(` ${glyph} `, { fg: piece && piece < 'a' ? '#ffffff' : '#0b1020', bg, bold: true });
      }
      out.push(row);
    }
  }
  const files = [...FILES].map((f) => ` ${f} `);
  out.push(style.paint(`  ${(flip ? files.reverse() : files).join('')}`, { fg: pulse.accent }));
  if (!game.over) {
    out.push(`${style.paint(' move ›', { fg: 'mute' })} ${style.paint(game.buffer, { fg: 'ink', bold: true })}${style.paint(style.on ? '▌' : '_', { fg: pulse.accent })}`);
  }
  return out;
}

module.exports = { snakeView, flappyView, blocksView, slideView, chessView, cellLines, PIECE_COLOR, slideColor };

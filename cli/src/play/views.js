'use strict';

/**
 * Pure views: game state → styled lines. Cosmetic only — nothing here feeds back
 * into an engine, so the replay contract (seed, input log) → score is untouched.
 * Colour comes from the shared palette (term.js); at depth 'none' every view
 * degrades to plain, fully usable text.
 */

const runner = require('./runner');
const { Framebuffer, heatColor, mix } = require('./term');

const CELL_ROWS = 8; // 2 sky + 4 play + ground + underground
const GROUND_PY = 12; // pixel row of the ground line (cell row 6, top half)

const hash = (n) => {
  let x = Math.imul(n ^ 61, 0x27d4eb2d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x2c1b3c6d) >>> 0;
  return (x ^ (x >>> 12)) >>> 0;
};

// 5 × 6 pixel dino facing right. '#' body, 'o' eye. Hitbox is the centre column (DINO_X): the sprite is forgiving.
const DINO = ['..###', '..#o#', '#.###', '#####', '.###.'];
const LEGS = ['.#.#.', '..#..'];

/** Ground scroll in columns: speed integrated over ticks (cosmetic parallax). */
function scrollOf(tick) {
  return Math.min(tick, 400) + (tick > 400 ? 2 * (tick - 400) : 0); // engine speed: 1 col/tick, 2 after tick 400
}

/**
 * Runner scene, 8 text rows of `min(FIELD_W, cols-1)` cells; half-block pixels give 16 pixel rows.
 * @param {object} state  runner state (read only)
 * @param {{style:object, cols:number, pulse:{t:number,accent:string}, started:boolean, overlay?:string}} o
 */
function runnerView(state, { style, cols, pulse, started, overlay = '' }) {
  const w = Math.max(10, Math.min(runner.FIELD_W, cols - 1));
  const sky = heatColor(started ? pulse.t : 0);
  const fb = new Framebuffer(w, CELL_ROWS, { bg: sky });
  fb.fillBg(0, 6, w, 2, 'night2');
  const tick = state.tick;
  const far = Math.floor(tick / 6);
  const near = Math.floor(tick / 3);

  // stars (two parallax layers); they warm toward white-amber as the wait drags on
  const starTint = mix('ink', 'amber', pulse.t);
  for (let x = 0; style.on && x < w; x++) {
    for (let py = 0; py < 7; py++) {
      if (hash((x + far) * 31 + py * 7) % 43 === 0) fb.px(x, py, mix(sky, 'mute', 0.7));
      if (py < 5 && hash((x + near) * 17 + py * 13 + 99) % 61 === 0) fb.px(x, py, ((tick >> 3) + (x & 1)) & 1 ? starTint : 'ink');
    }
  }
  // moon → sun as the heat builds
  const moon = mix('ink', 'amber', pulse.t);
  for (const [dx, dy] of !style.on ? [] : [[0, 0], [1, 0], [0, 1], [1, 1]]) fb.px(w - 6 + dx, 2 + dy, moon);

  // far hills (slow parallax)
  const hillColor = mix(sky, '#000000', 0.35);
  const off = Math.floor(tick / 2);
  for (let x = 0; style.on && x < w; x++) {
    const v = Math.abs(((x + off) % 24) - 12);
    const v2 = Math.abs(((x * 2 + off * 3) % 17) - 8);
    const hh = Math.floor((12 - v) / 3) + (v2 < 2 ? 1 : 0);
    for (let k = 1; k <= hh; k++) fb.px(x, GROUND_PY - k, hillColor);
  }

  // ground line + scrolling texture
  const sc = scrollOf(tick);
  for (let x = 0; x < w; x++) {
    fb.px(x, GROUND_PY, 'line');
    const h = hash((x + sc) * 13 + 5) % 9;
    if (h === 0) fb.text(x, 7, '·', { fg: 'line', bg: 'night2' });
    else if (h === 1) fb.text(x, 7, '▁', { fg: 'line', bg: 'night2' });
  }

  // cacti
  for (const o of state.obstacles) {
    const ph = o.h * 2;
    for (let dx = 0; dx < o.w; dx++) {
      for (let k = 1; k <= ph; k++) fb.px(o.x + dx, GROUND_PY - k, 'green');
      fb.px(o.x + dx, GROUND_PY - ph, 'lime');
    }
    if (ph >= 3) { // an arm, outside the hitbox
      fb.px(o.x - 1, GROUND_PY - 2, 'green');
      fb.px(o.x - 1, GROUND_PY - 3, 'green');
    }
  }

  // dino
  const h = runner.dinoHeight(state);
  const footPy = GROUND_PY - h * 2;
  const rows = DINO.concat([started && state.alive && h === 0 ? LEGS[Math.floor(tick / 3) % 2] : LEGS[0]]);
  const body = state.alive ? 'lime' : 'red';
  fb.sprite(runner.DINO_X - 2, footPy - 6, rows, { '#': body, o: state.alive ? 'night' : 'ink' });

  if (overlay) fb.text(Math.max(0, Math.floor((w - Array.from(overlay).length) / 2)), 3, ` ${overlay} `, { fg: 'ink', bg: 'panel', bold: true });
  return fb.toLines(style);
}

// ── termo ───────────────────────────────────────────────────────────────────

const MARK_BG = { G: 'green', Y: 'gold', B: 'slate' };
const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const RANK = { G: 3, Y: 2, B: 1 };

/** Best known mark per letter across all guesses: {letter: 'G'|'Y'|'B'}. */
function keyStates(tm) {
  const out = {};
  tm.guesses.forEach((g, r) => {
    [...g].forEach((ch, i) => {
      const m = tm.marks[r][i];
      if (!out[ch] || RANK[m] > RANK[out[ch]]) out[ch] = m;
    });
  });
  return out;
}

function tile(ch, mark, style) {
  const L = ch.toUpperCase();
  if (!style.on) return mark === 'G' ? `[${L}]` : mark === 'Y' ? `(${L})` : `.${L}.`;
  return style.paint(` ${L} `, { fg: 'night', bg: MARK_BG[mark], bold: true });
}

/**
 * Termo board + keyboard heatmap. `tall` (enough rows) draws 2-row tiles with a blank line between guesses.
 * @param {{style:object, rows:number, buffer:string, wordLen:number, maxGuesses:number}} o
 */
function termoView(tm, { style, rows, buffer, wordLen, maxGuesses }) {
  const tall = rows >= 34;
  const lines = [];
  const gap = style.on ? ' ' : ' ';
  const empty = (txt, active) => style.paint(txt, { fg: active ? 'ink' : 'line', bg: active ? 'panel' : undefined, bold: active });
  for (let r = 0; r < maxGuesses; r++) {
    const g = tm.guesses[r];
    let cells;
    if (g) cells = [...g].map((ch, i) => tile(ch, tm.marks[r][i], style));
    else if (r === tm.guesses.length && !tm.over) {
      cells = Array.from({ length: wordLen }, (_, i) => empty(` ${(buffer[i] || '_').toUpperCase()} `, true));
    } else cells = Array.from({ length: wordLen }, () => empty(' · ', false));
    lines.push(`  ${cells.join(gap)}`);
    if (tall && style.on) lines.push(`  ${[...cells].map(() => '   ').join(gap)}`.replace(/ +$/, ''));
  }
  lines.push('');
  const st = keyStates(tm);
  if (style.on) {
    KEY_ROWS.forEach((row, ri) => {
      const keys = [...row].map((ch) => {
        const m = st[ch];
        const o = m ? { fg: m === 'B' ? 'mute' : 'night', bg: MARK_BG[m], bold: true } : { fg: 'ink', bg: 'panel' };
        return style.paint(` ${ch.toUpperCase()} `, o);
      });
      lines.push(`${' '.repeat(2 + ri * 2)}${keys.join('')}`);
    });
  } else {
    const absent = Object.keys(st).filter((k) => st[k] === 'B').sort().join(' ').toUpperCase();
    if (absent) lines.push(`  - ${absent}`);
  }
  return lines;
}

module.exports = { runnerView, termoView, keyStates, CELL_ROWS };

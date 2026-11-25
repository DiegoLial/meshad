'use strict';

/**
 * Shared terminal render layer for `meshad play`, the menus and the news view.
 * Pure string building — it never touches a stream, a clock or the network.
 *
 *   detectDepth(env, isTTY)  'none' | '16' | '256' | 'truecolor'   (NO_COLOR / non-TTY → 'none')
 *   PALETTE                  the one MeshAd palette, defined once, mapped to each depth by makeStyle
 *   makeStyle(depth)         paint / gradient / raw SGR openers; at 'none' every call returns plain text
 *   Framebuffer              cell grid with a half-block (▀▄) pixel mode: 2 pixel rows per text row
 *   rowsPatch(prev, next)    cursor-addressed rewrite of ONLY the rows that changed ('' when nothing did)
 *   statusBar(...)           the bottom row: game · score · best · streak · agent state + thinking meter
 */

const { displayWidth, truncateToWidth, brandFallbacks } = require('../creative');

const ESC = '\x1b';
const RESET = `${ESC}[0m`;

/** The MeshAd palette: deep-night surfaces, neon accents, amber for warnings. */
const PALETTE = Object.freeze({
  night: '#0b1020', // background
  night2: '#141b34', // far hills / raised surface
  panel: '#1f2850', // highlight bar, status bar
  line: '#4a5578', // ground line, borders
  mute: '#7d8aa8', // secondary text
  ink: '#e6edf7', // primary text
  cyan: '#00e5ff',
  magenta: '#ff2bd6',
  lime: '#b6ff3c',
  amber: '#ffb000',
  red: '#ff4d5e',
  violet: '#8b5cf6',
  sky: '#4cc9f0',
  green: '#3ddc84', // termo: right place
  gold: '#f5c518', // termo: elsewhere
  slate: '#3a4260', // termo: absent
});

/** Wait heat ramp, night → ember: the sky of the game while the agent thinks. */
const HEAT_STOPS = ['#0b1020', '#2a1650', '#5a1a3a', '#7a3010'];

function detectDepth(env = process.env, isTTY = !!(process.stdout && process.stdout.isTTY)) {
  if (env.NO_COLOR !== undefined) return 'none'; // any value, per no-color.org
  if (!isTTY || env.TERM === 'dumb') return 'none';
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  if (/256color/i.test(String(env.TERM || ''))) return '256';
  return '16';
}

const hexCache = new Map();
/** palette name | '#rrggbb' | [r,g,b] → [r,g,b], or null. */
function rgbOf(color) {
  if (color == null) return null;
  if (Array.isArray(color)) return color;
  const key = String(color);
  if (hexCache.has(key)) return hexCache.get(key);
  const hex = PALETTE[key] || key;
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  const rgb = m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
  hexCache.set(key, rgb);
  return rgb;
}

function mix(a, b, t) {
  const x = rgbOf(a) || [0, 0, 0];
  const y = rgbOf(b) || x;
  const k = Math.min(1, Math.max(0, t));
  return x.map((v, i) => Math.round(v + (y[i] - v) * k));
}

/** Sky colour for heat t ∈ [0,1]: night → violet → wine → ember. */
function heatColor(t) {
  const k = Math.min(1, Math.max(0, t)) * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(k));
  return mix(HEAT_STOPS[i], HEAT_STOPS[i + 1], k - i);
}

const ANSI16 = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];

function to16(rgb) {
  let best = 0;
  let bestD = Infinity;
  ANSI16.forEach((c, i) => {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function to256(rgb) {
  const [r, g, b] = rgb;
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 23);
  }
  const q = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** SGR parameter string for a colour at a depth ('' when unrepresentable). kind: 'fg' | 'bg'. */
function colorCode(depth, kind, color) {
  if (color && typeof color === 'object' && !Array.isArray(color) && color.brand) {
    // A verified advertiser brand colour ({ brand: '#rrggbb' }, see skinAccent): same
    // degradation as the footer renderer — 24-bit, nearest xterm-256 index, nearest basic name.
    const rgb = rgbOf(color.brand);
    if (!rgb || depth === 'none') return '';
    const fb = brandFallbacks(color.brand);
    if (depth === 'truecolor') return `${kind === 'fg' ? 38 : 48};2;${rgb[0]};${rgb[1]};${rgb[2]}`;
    if (depth === '256') return `${kind === 'fg' ? 38 : 48};5;${fb.ansi256}`;
    return String((kind === 'fg' ? 30 : 40) + ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].indexOf(fb.ansi16));
  }
  const rgb = rgbOf(color);
  if (!rgb || depth === 'none') return '';
  if (depth === 'truecolor') return `${kind === 'fg' ? 38 : 48};2;${rgb[0]};${rgb[1]};${rgb[2]}`;
  if (depth === '256') return `${kind === 'fg' ? 38 : 48};5;${to256(rgb)}`;
  const i = to16(rgb);
  return String(i < 8 ? (kind === 'fg' ? 30 : 40) + i : (kind === 'fg' ? 90 : 100) + (i - 8));
}

/** A painter bound to one colour depth. At 'none' it is the identity: plain text, still usable. */
function makeStyle(depth = 'none') {
  const on = depth !== 'none';
  const open = (o = {}) => {
    const codes = [];
    if (o.bold) codes.push('1');
    if (o.dim) codes.push('2');
    if (o.underline) codes.push('4');
    const fg = colorCode(depth, 'fg', o.fg);
    const bg = colorCode(depth, 'bg', o.bg);
    if (fg) codes.push(fg);
    if (bg) codes.push(bg);
    return codes.length ? `${ESC}[${codes.join(';')}m` : '';
  };
  return {
    depth,
    on,
    RESET,
    open,
    paint(text, o) {
      const s = String(text);
      if (!on) return s;
      const op = open(o);
      return op ? `${op}${s}${RESET}` : s;
    },
    /** Per-character colour ramp from → to. */
    gradient(text, from, to, o = {}) {
      const s = String(text);
      if (!on) return s;
      const chars = Array.from(s);
      const n = Math.max(1, chars.length - 1);
      return chars.map((ch, i) => (ch === ' ' ? ch : `${open({ ...o, fg: mix(from, to, i / n) })}${ch}${RESET}`)).join('');
    },
  };
}

/** Style for the real process, honouring NO_COLOR / TTY / TERM. `stream` defaults to stdout. */
function autoStyle(env = process.env, stream = process.stdout) {
  return makeStyle(detectDepth(env, !!(stream && stream.isTTY)));
}

// ── framebuffer ─────────────────────────────────────────────────────────────

/**
 * w × h text cells; `px()` addresses 2·h pixel rows (top half / bottom half of
 * each cell, drawn with ▀ ▄ and a fg/bg pair). Text and pixels share a cell:
 * the last write wins. Colours are palette names, '#rrggbb' or [r,g,b].
 */
class Framebuffer {
  constructor(w, h, { bg = 'night' } = {}) {
    this.w = w;
    this.h = h;
    this.cells = Array.from({ length: w * h }, () => ({ ch: ' ', fg: null, bg, bold: false, dim: false, top: null, bot: null }));
  }

  cell(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.cells[y * this.w + x] : null;
  }

  /** Background colour of a rectangle of cells. */
  fillBg(x, y, w, h, bg) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { const c = this.cell(i, j); if (c) c.bg = bg; }
  }

  /** Write text (one cell per char) starting at (x, y). */
  text(x, y, str, { fg = 'ink', bg, bold = false, dim = false } = {}) {
    let i = x;
    for (const ch of Array.from(String(str))) {
      const c = this.cell(i++, y);
      if (!c) continue;
      c.ch = ch;
      c.fg = fg;
      c.bold = bold;
      c.dim = dim;
      c.top = null;
      c.bot = null;
      if (bg !== undefined) c.bg = bg;
    }
  }

  /** One pixel; py ∈ [0, 2h). A null colour erases it. */
  px(x, py, color) {
    const c = this.cell(x, py >> 1);
    if (!c) return;
    c.ch = ' ';
    if (py & 1) c.bot = color; else c.top = color;
  }

  rect(x, py, w, ph, color) {
    for (let j = py; j < py + ph; j++) for (let i = x; i < x + w; i++) this.px(i, j, color);
  }

  /** Draw a sprite: rows of chars, '.' or ' ' transparent, other chars looked up in `colors`. */
  sprite(x, py, rows, colors) {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch !== '.' && ch !== ' ' && colors[ch] != null) this.px(x + i, py + j, colors[ch]);
      }
    });
  }

  /** Styled rows, each exactly w cells wide (plain text at depth 'none'). */
  toLines(style) {
    const lines = [];
    for (let y = 0; y < this.h; y++) {
      let out = '';
      let curKey = null;
      for (let x = 0; x < this.w; x++) {
        const c = this.cells[y * this.w + x];
        let ch = c.ch;
        let fg = c.fg;
        let bg = c.bg;
        if (c.top != null || c.bot != null) {
          if (c.top != null && c.bot != null) {
            const same = String(c.top) === String(c.bot);
            ch = same ? '█' : '▀';
            fg = c.top;
            bg = same ? c.bg : c.bot;
          } else if (c.top != null) { ch = '▀'; fg = c.top; } else { ch = '▄'; fg = c.bot; }
        }
        if (!style.on) { out += ch; continue; }
        const key = `${String(fg)}|${String(bg)}|${c.bold}|${c.dim}`;
        if (key !== curKey) {
          out += `${curKey === null ? '' : RESET}${style.open({ fg, bg, bold: c.bold, dim: c.dim })}`;
          curKey = key;
        }
        out += ch;
      }
      lines.push(style.on ? `${out}${RESET}` : out.replace(/\s+$/, ''));
    }
    return lines;
  }
}

// ── line diff ───────────────────────────────────────────────────────────────

/** Indexes of rows that differ between two frames (a missing row counts as ''). */
function diffRows(prev, next) {
  const out = [];
  const n = Math.max(prev.length, next.length);
  for (let i = 0; i < n; i++) if ((prev[i] ?? '') !== (next[i] ?? '')) out.push(i);
  return out;
}

/**
 * Escape sequence that turns the screen showing `prev` into `next`, touching only
 * changed rows. '' when nothing changed — the caller writes nothing at all.
 */
function rowsPatch(prev, next) {
  let out = '';
  for (const i of diffRows(prev, next)) out += `${ESC}[${i + 1};1H${next[i] ?? ''}${ESC}[0m${ESC}[K`;
  return out;
}

// ── status bar ──────────────────────────────────────────────────────────────

/** Wait pulse: how "hot" the thinking is. t ∈ [0,1] over HEAT_FULL_MS; tier 0..3. */
const HEAT_FULL_MS = 60_000;
const HEAT_TIERS_MS = [0, 8_000, 25_000, 60_000];

function pulseFor(waitMs) {
  const ms = Math.max(0, Number(waitMs) || 0);
  let tier = 0;
  HEAT_TIERS_MS.forEach((limit, i) => { if (ms >= limit) tier = i; });
  return { ms, t: Math.min(1, ms / HEAT_FULL_MS), tier, accent: ['cyan', 'lime', 'amber', 'red'][tier] };
}

/** ▰▰▰▱▱▱ — `frac` ∈ [0,1] filled cells in `accent`, the rest in line colour. */
function meter(frac, width, style, accent = 'cyan', bg) {
  const filled = Math.round(Math.min(1, Math.max(0, frac)) * width);
  return style.paint('▰'.repeat(filled), { fg: accent, bg }) + style.paint('▱'.repeat(width - filled), { fg: 'line', bg });
}

/**
 * Bottom row: ` ▲ RUNNER │ score 120 │ best 340 │ 🔥 3 │ ● thinking ▰▰▱▱▱▱ 12s `.
 * Segments are dropped lowest-priority first (meter, streak, best) until it fits `cols - 1`.
 * @param {{style:object, cols:number, game:string, score:number|string, best:number, streak:number,
 *          state:'waiting'|'idle'|'free', stateLabel:string, labels:{score:string,best:string}, waitMs?:number}} o
 */
function statusBar({ style, cols, game, score, best, streak, state, stateLabel, labels, waitMs = 0 }) {
  const width = Math.max(10, cols - 1);
  const heat = pulseFor(waitMs);
  const bg = 'panel';
  const stateColor = state === 'waiting' ? heat.accent : state === 'idle' ? 'magenta' : 'mute';
  const secs = `${Math.floor(heat.ms / 1000)}s`;
  const segs = [
    { prio: 10, plain: ` ${game} `, paint: (s) => style.paint(s, { fg: 'night', bg: 'cyan', bold: true }) },
    { prio: 9, plain: ` ${labels.score} ${score} `, paint: (s) => style.paint(s, { fg: 'ink', bg, bold: true }) },
    { prio: 5, plain: ` ${labels.best} ${best} `, paint: (s) => style.paint(s, { fg: 'mute', bg }) },
    { prio: 4, plain: streak > 0 ? ` 🔥 ${streak} ` : '', paint: (s) => style.paint(s, { fg: 'amber', bg }) },
    { prio: 8, plain: ` ${state === 'waiting' ? '●' : '○'} ${stateLabel} `, paint: (s) => style.paint(s, { fg: stateColor, bg, bold: true }) },
    {
      prio: 3,
      plain: state === 'waiting' ? ` ${'▰'.repeat(6)} ${secs} ` : '',
      paint: () => `${style.paint(' ', { bg })}${meter(heat.t, 6, style, heat.accent, bg)}${style.paint(` ${secs} `, { fg: 'mute', bg })}`,
    },
  ];
  const live = segs.filter((s) => s.plain);
  const sepW = displayWidth('│');
  const total = () => live.reduce((n, s) => n + displayWidth(s.plain), 0) + Math.max(0, live.length - 1) * sepW;
  while (live.length > 2 && total() > width) {
    const drop = live.reduce((lo, s) => (s.prio < lo.prio ? s : lo));
    live.splice(live.indexOf(drop), 1);
  }
  if (total() > width) return truncateToWidth(live[0].plain, width);
  const out = live.map((s) => s.paint(s.plain)).join(style.paint('│', { fg: 'line', bg }));
  return `${out}${style.paint(' '.repeat(Math.max(0, width - total())), { bg })}`;
}

// ── terminal safety ─────────────────────────────────────────────────────────

const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

/**
 * Make sure the terminal is given back however the process ends: on `exit`, on
 * SIGINT / SIGTERM / SIGHUP and on an uncaught error. `restore` must be idempotent
 * (show the cursor, leave the alternate screen, drop raw mode). With `onSignal`
 * a signal asks the owner to close gracefully (it resolves its own promise);
 * without it the process restores and exits 128+n. Returns `release()`.
 * @param {{restore:Function, onSignal?:(name:string)=>void}} o
 */
function guardTerminal({ restore, onSignal = null }) {
  const handlers = [];
  const on = (ev, fn) => { process.on(ev, fn); handlers.push([ev, fn]); };
  on('exit', restore);
  for (const [name, num] of Object.entries(SIGNALS)) {
    on(name, () => {
      if (onSignal) onSignal(name);
      else { restore(); process.exit(128 + num); }
    });
  }
  on('uncaughtException', (err) => {
    try { restore(); } catch { /* nothing left to do */ }
    process.stderr.write(`${(err && err.stack) || err}\n`);
    process.exit(1);
  });
  return () => { for (const [ev, fn] of handlers) process.off(ev, fn); };
}

module.exports = {
  HIDE_CURSOR, SHOW_CURSOR, guardTerminal,
  PALETTE, HEAT_FULL_MS, detectDepth, makeStyle, autoStyle, rgbOf, mix, heatColor, colorCode,
  Framebuffer, diffRows, rowsPatch, pulseFor, meter, statusBar, RESET,
};

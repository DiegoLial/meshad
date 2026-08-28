'use strict';

/**
 * Footer renderer — 1 to 6 rows depending on format. Fail-closed: any
 * problem (no TTY, weird terminal, write error) means NO ad — never an
 * exception for the caller, never a corrupted screen.
 *
 * Render: save cursor (ESC 7) → jump to the last N rows → write each line
 * → restore (ESC 8). Clear: same dance, erase exactly the N rows that were
 * last drawn (tracked in `activeHeight`) — both are a single synchronous
 * write per call, clear completes in well under 100ms.
 */

const {
  FG_CODES, MAX_ART_LINES, displayWidth, truncateToWidth, renderLine,
  validateFrames, sliceSpans, DEFAULT_HOLD_MS,
} = require('./creative');

const ESC = '\x1b';
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;

const COLOR_CODES = { dim: '2', green: '32', cyan: '36', magenta: '35', yellow: '33', blue: '34', red: '31' };

/** Text formats stay at 5 rows; `ascii_panel` buys one more for its art. */
const MAX_ROWS_TEXT = 5;
const MAX_ROWS_ART = MAX_ART_LINES + 1; // art + the mandatory sponsored row

/** Entrance reveal: ~300ms total, then the ad holds still for the rest of the wait. */
const REVEAL_STEPS = 12;
const REVEAL_FRAME_MS = 25;

/** Art needs room to read as art. Below this the ad degrades to one text line. */
const MIN_COLS_ART = 60;
// A framed panel is at most 8 rows; 12 leaves it room plus host breathing
// space. (Was 20 — a pre-panel threshold that degraded perfectly viable
// terminals to the flattened one-liner.)
const MIN_ROWS_ART = 12;

function colorCode(color) {
  return COLOR_CODES[color] || COLOR_CODES.dim;
}

/** Strip control/newline characters and clamp width — never trust ad content blindly. */
function sanitizeLine(s, maxWidth) {
  return truncateToWidth(
    String(s ?? '').replace(/[\r\n\x00-\x08\x0b-\x1f]/g, ' '),
    Math.max(0, maxWidth),
  );
}

class LineRenderer {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.active = false;
    this.activeHeight = 0;
  }

  get enabled() {
    return !!(this.stream && this.stream.isTTY);
  }

  /**
   * Draw `payload` — a single string (legacy text_line callers) or an array
   * of already-ANSI-formatted lines (see formatAd) — on the bottom rows of
   * the screen. Returns true only if actually drawn.
   */
  render(payload) {
    try {
      if (!this.enabled) return false;
      const lines = Array.isArray(payload) ? payload : [payload];
      const cols = this.stream.columns || 80;
      const rows = this.stream.rows || 24;
      const height = Math.min(lines.length, rows - 1, MAX_ROWS_ART + 2); // +2: panel borders
      if (height <= 0) return false;

      // Anti-flicker, two layers: (1) overwrite-with-padding instead of
      // erase-then-repaint — a cleared line must never be visible between
      // frames of an animation; the trailing ESC[K only clears what the
      // padding did not reach, after the content is already painted.
      // (2) DEC synchronized output (mode 2026): terminals that support it
      // apply the whole frame atomically; the rest ignore it harmlessly.
      let out = `${ESC}[?2026h`;
      if (!this.active) {
        // First draw: push the host's current line (prompt, spinner) above the
        // ad zone and fence scrolling out of it with a scroll region (DECSTBM).
        // Without this, the shell's own bottom line sits inside the panel and
        // every frame paints over it — "the Thinking… spinner vanished".
        out += `${'\n'.repeat(height)}${ESC}[${height}A`;
        out += `${SAVE}${ESC}[1;${Math.max(1, rows - height)}r${RESTORE}`;
      }
      out += SAVE;
      for (let i = 0; i < height; i++) {
        const targetRow = rows - height + 1 + i;
        const { text: raw, width } = sanitizeAnsiLine(String(lines[i] ?? ''), cols - 1);
        const pad = ' '.repeat(Math.max(0, cols - 1 - width));
        out += `${ESC}[${targetRow};1H${raw}${ESC}[0m${pad}${ESC}[K`;
      }
      out += `${RESTORE}${ESC}[?2026l`;
      this.stream.write(out);
      this.active = true;
      this.activeHeight = height;
      return true;
    } catch {
      this.active = false;
      this.activeHeight = 0;
      return false;
    }
  }

  /** Erase every row last drawn. Idempotent, synchronous, <100ms. */
  clear() {
    try {
      if (!this.enabled || !this.active) {
        this.active = false;
        this.activeHeight = 0;
        return;
      }
      const rows = this.stream.rows || 24;
      let out = `${ESC}[?2026h${SAVE}`;
      for (let i = 0; i < this.activeHeight; i++) {
        out += `${ESC}[${rows - this.activeHeight + 1 + i};1H${ESC}[2K`;
      }
      // Release the scroll-region fence (DECSTBM homes the cursor, so this
      // stays inside the SAVE/RESTORE bracket).
      out += `${ESC}[r${RESTORE}${ESC}[?2026l`;
      this.stream.write(out);
    } catch {
      /* fail-closed: nothing to do */
    }
    this.active = false;
    this.activeHeight = 0;
  }
}

/** SGR-only escape: \x1b[ <digits and semicolons> m. Nothing else is an escape. */
const SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * Last line of defence before bytes reach the terminal. Styling escapes we
 * generated (SGR, i.e. colour/bold/reset) survive; every other escape sequence
 * and control character is erased, so nothing can move the cursor, clear the
 * screen, repaint the palette or open a hyperlink. Width is measured on the
 * visible text only — escapes occupy no columns.
 */
function sanitizeAnsiLine(line, maxWidth) {
  const s = String(line ?? '');
  const styles = [];
  // Park the legitimate SGR codes, scrub what is left, then put them back.
  const parked = s.replace(SGR_RE, (m) => {
    styles.push(m);
    return '\x00SGR\x01';
  });
  const scrubbed = parked.replace(/[\r\n\x1b\x02-\x08\x0b-\x1f\x7f]/g, ' ');

  let width = 0;
  let out = '';
  let i = 0;
  const parts = scrubbed.split('\x00SGR\x01');
  for (const part of parts) {
    const room = Math.max(0, maxWidth - width);
    const text = truncateToWidth(part, room);
    out += text;
    width += displayWidth(text);
    if (i < styles.length) out += styles[i++];
  }
  while (i < styles.length) out += styles[i++]; // keep any trailing reset
  return { text: out, width };
}

/**
 * Compose "content  <cta · sponsored · hint>" into one line, reserving the
 * suffix's width FIRST and spending what is left on the content.
 *
 * Truncating from the right — which is what a naive clamp does — eats the
 * sponsored label on a narrow terminal and renders an undisclosed ad. The
 * disclosure is not the part that gives way. If the suffix alone does not fit,
 * there is no honest ad to draw, so we return null and nothing is shown.
 */
function composeWithSuffix(content, suffix, maxWidth) {
  const suffixWidth = displayWidth(suffix);
  if (suffixWidth > maxWidth) return null; // cannot disclose => do not advertise
  const room = maxWidth - suffixWidth - 2; // 2 = the separating spaces
  if (room <= 0) return suffix;

  const clean = sanitizeLine(content, Infinity);
  if (displayWidth(clean) <= room) return clean ? `${clean}  ${suffix}` : suffix;

  // Truncated: mark it. A phrase that just stops mid-word reads as a rendering
  // bug; an ellipsis reads as a deliberate cut.
  const body = sanitizeLine(clean, Math.max(0, room - 1)).replace(/[\s.,;:—-]+$/, '');
  return body ? `${body}…  ${suffix}` : suffix;
}

/**
 * Render an ad into 1-6 already-colored, ANSI-ready lines, per its format:
 *   text_line   — one line: emoji + text + cta + sponsored label.
 *   text_block  — 2-4 lines: content lines, then the cta/sponsored line.
 *   rich_panel  — a bordered box (┌─┐ / │ │ / └─┘) around the same content.
 *   ascii_panel — multi-colour art: each line is an array of {t,fg,bg,bold}
 *                 spans, styled by @meshad/creative. The advertiser never
 *                 supplies an escape sequence; we synthesize every one.
 * The `sponsored` label and pause hint are non-negotiable and always present.
 */
/** The art an ad shows when standing still: its flat art, or its first frame. */
function firstArt(render) {
  if (Array.isArray(render.art_lines) && render.art_lines.length) return render.art_lines;
  const frames = render.frames;
  if (Array.isArray(frames) && frames.length && Array.isArray(frames[0].art_lines)) return frames[0].art_lines;
  return [];
}

function formatAd(ad, cols = 80, rows = 24) {
  const r = (ad && ad.render) || {};
  const code = colorCode(r.color);
  const emojiPrefix = r.emoji ? `${r.emoji} ` : '';
  const suffix = `${r.cta || ''} · sponsored · (meshad pause)`;
  const maxWidth = Math.max(20, cols - 1);
  const contentLines = (Array.isArray(r.lines) && r.lines.length ? r.lines : [r.text || '']).slice(0, 3);
  const wrap = (s) => `\x1b[${code}m${s}`;

  const format = ad && ad.format;

  if (format === 'ascii_panel') {
    const art0 = firstArt(r);
    // Degrade to a single text line on a terminal too small for the art to read.
    if (cols >= MIN_COLS_ART && rows >= MIN_ROWS_ART && art0.length) {
      const artInner = Math.min(
        maxWidth - 4,
        Math.max(20, ...art0.slice(0, MAX_ART_LINES).map((line) =>
          (Array.isArray(line) ? line : []).reduce((w, sp) => w + displayWidth((sp && sp.t) || ''), 0)),
        displayWidth(suffix)),
      );
      const art = art0
        .slice(0, MAX_ART_LINES)
        .map((line) => renderLine(line, artInner));
      return framePanel([...art, wrap(sanitizeLine(suffix, artInner))], artInner, code);
    }
    // Flattening keeps only word-bearing spans: bar/box glyphs (▇░█─╱╲…) are
    // meaningless squashed into one line and read as garbage.
    const GLYPH_ONLY = /^[\s▁▂▃▄▅▆▇█░▒▓─│╭╮╰╯╱╲◉●▮▲✓☁~≈]*$/;
    const flat = art0
      .map((line) => (Array.isArray(line) ? line : [])
        .map((s) => ((s && s.t) || ''))
        .filter((tx) => !GLYPH_ONLY.test(tx))
        .join(''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const composed = composeWithSuffix(`${emojiPrefix}${flat || contentLines[0] || ''}`, suffix, maxWidth);
    return composed === null ? [] : [wrap(composed)];
  }

  if (format === 'rich_panel' && cols >= 40) {
    // Budget: top border + content + suffix + bottom border must fit the cap.
    const bodyBudget = MAX_ROWS_TEXT - 3; // 2 borders + suffix row
    const rawRows = [
      ...contentLines.slice(0, bodyBudget).map((l, i) => `${i === 0 ? emojiPrefix : ''}${l}`),
      suffix,
    ];
    const innerWidth = Math.min(maxWidth - 4, Math.max(...rawRows.map((l) => displayWidth(l))));
    const pad = (s) => {
      const clipped = sanitizeLine(s, innerWidth);
      return ` ${clipped}${' '.repeat(Math.max(0, innerWidth - displayWidth(clipped)))} `;
    };
    const top = `┌${'─'.repeat(innerWidth + 2)}┐`;
    const bottom = `└${'─'.repeat(innerWidth + 2)}┘`;
    const panelRows = [top, ...rawRows.map((l) => `│${pad(l)}│`), bottom];
    return panelRows.map(wrap);
  }

  if (format === 'text_block' || format === 'rich_panel' /* too narrow: degrade */) {
    const blockRows = [...contentLines.map((l, i) => `${i === 0 ? emojiPrefix : ''}${l}`), suffix].map((l) =>
      sanitizeLine(l, maxWidth),
    );
    return blockRows.map(wrap);
  }

  // text_line (default, and the fallback for any unknown future format)
  const line = composeWithSuffix(`${emojiPrefix}${contentLines[0] || ''}`, suffix, maxWidth);
  return line === null ? [] : [wrap(line)];
}


/**
 * Frames for the entrance reveal: the art wipes in left-to-right, then holds.
 *
 * The creative is untouched — these are derived client-side from the same signed
 * spans by asking renderLine for a growing width, so animating costs no payload,
 * no second signature and no moderation surface. Nothing is animated after the
 * reveal completes: the ad occupies idle time, it does not compete for attention
 * with what the developer is actually waiting for.
 *
 * The sponsored row is drawn in full from frame one. Disclosure is never
 * partially revealed, not even for 300ms.
 *
 * @returns {string[][]} one entry per frame; a single entry means "do not animate".
 */
function revealFrames(ad, cols = 80, rows = 24, steps = REVEAL_STEPS) {
  const final = formatAd(ad, cols, rows);
  const r = (ad && ad.render) || {};

  // Only ascii_panel animates, and only when it rendered as art (not degraded
  // to the one-line fallback, where there is nothing to wipe in).
  const isArt = ad && ad.format === 'ascii_panel' && final.length > 1;
  if (!isArt) return [final];

  const maxWidth = Math.max(20, cols - 1);
  const artSpans = firstArt(r).slice(0, MAX_ART_LINES);
  if (!artSpans.length) return [final];
  const widest = Math.max(
    1,
    ...artSpans.map((line) =>
      (Array.isArray(line) ? line : []).reduce((w, sp) => w + displayWidth((sp && sp.t) || ''), 0),
    ),
  );
  // The panel is at its full size from the very first frame — only the art
  // inside grows. Same width formula as formatAd, so the reveal's final frame
  // can be the static render itself, byte for byte.
  const code = colorCode(r.color);
  const suffixPlain = `${r.cta || ''} · sponsored · (meshad pause)`;
  const innerWidth = Math.min(maxWidth - 4, Math.max(20, widest, displayWidth(suffixPlain)));
  const suffixRow = `\x1b[${code}m${sanitizeLine(suffixPlain, innerWidth)}`;
  const target = Math.min(widest, innerWidth);
  const frameCount = Math.max(1, Math.min(steps, target));

  const frames = [];
  for (let i = 1; i < frameCount; i++) {
    const width = Math.ceil((target * i) / frameCount);
    frames.push(drawFrame(artSpans.map((line) => sliceSpans(line, 0, width)), suffixRow, innerWidth, code));
  }
  frames.push(final);
  return frames;
}


/* ── animation ────────────────────────────────────────────────────────────── */

/** Sub-frame durations for the transitions the client draws between frames. */
const WIPE_STEP_MS = 22;
const WIPE_STEPS = 14;
const TYPE_STEP_MS = 18;

/** Style one art line, plus the fixed sponsored row, into a drawable frame. */
/** Visible width of an already-ANSI-styled row. */
function visibleWidth(s) {
  return displayWidth(String(s).replace(SGR_RE, ''));
}

/**
 * Wrap fully-rendered rows in a rounded panel. Presentation only — the border
 * is drawn by the client from its own glyphs (no advertiser bytes, outside the
 * signature like every other pixel of chrome). It exists so an ad reads as a
 * clearly bounded object on screen, never as loose terminal output.
 */
function framePanel(rows, innerWidth, code) {
  const b = (s) => `\x1b[${code}m${s}\x1b[0m`;
  const top = b(`╭${'─'.repeat(innerWidth + 2)}╮`);
  const bottom = b(`╰${'─'.repeat(innerWidth + 2)}╯`);
  const body = rows.map((row) => {
    const pad = ' '.repeat(Math.max(0, innerWidth - visibleWidth(row)));
    return `${b('│')} ${row}\x1b[0m${pad} ${b('│')}`;
  });
  return [top, ...body, bottom];
}

function drawFrame(artSpans, suffixRow, innerWidth, code) {
  return framePanel([...artSpans.map((line) => renderLine(line, innerWidth)), suffixRow], innerWidth, code);
}

/**
 * Expand an animated creative into a flat timeline of {lines, ms} steps.
 *
 * Frames come from the creative and are covered by its signature; the steps
 * BETWEEN them (wipe columns, typewriter characters) are derived here from those
 * same signed spans, so a transition adds nothing to the payload and nothing to
 * moderation's surface.
 *
 * The sponsored row is rebuilt into every single step. There is no sub-frame,
 * transitional or otherwise, in which the ad is on screen undisclosed.
 *
 * @returns {{ steps: Array<{lines: string[], ms: number}>, loop: boolean }}
 */
function buildTimeline(ad, cols = 80, rows = 24) {
  const r = (ad && ad.render) || {};
  const staticLines = formatAd(ad, cols, rows);

  const isArt = ad && ad.format === 'ascii_panel' && staticLines.length > 1;
  if (!isArt) return { steps: [{ lines: staticLines, ms: 0 }], loop: false };

  const { frames } = validateFrames(r.frames ? { frames: r.frames } : { art_lines: r.art_lines || [] });
  if (!frames.length) return { steps: [{ lines: staticLines, ms: 0 }], loop: false };

  const maxWidth = Math.max(20, cols - 1);
  const transition = r.transition || 'cut';
  const loop = !!r.loop && frames.length > 1;

  const widthOf = (art) =>
    Math.max(0, ...art.map((line) => (Array.isArray(line) ? line : []).reduce(
      (w, sp) => w + displayWidth((sp && sp.t) || ''), 0)));

  // The panel width is fixed across every step of every frame — a border that
  // resizes mid-typewriter reads as glitching, not animating.
  const code = colorCode(r.color);
  const suffixPlain = `${r.cta || ''} · sponsored · (meshad pause)`;
  const innerWidth = Math.min(
    maxWidth - 4,
    Math.max(20, ...frames.map((f) => widthOf(f.art_lines.slice(0, MAX_ART_LINES))), displayWidth(suffixPlain)),
  );
  const suffixRow = `\x1b[${code}m${sanitizeLine(suffixPlain, innerWidth)}`;

  const steps = [];

  frames.forEach((frame, index) => {
    const art = frame.art_lines.slice(0, MAX_ART_LINES);
    const previous = index > 0 ? frames[index - 1].art_lines.slice(0, MAX_ART_LINES) : null;
    const target = Math.min(Math.max(widthOf(art), previous ? widthOf(previous) : 0), maxWidth);

    if (transition === 'wipe' && target > 0) {
      // The incoming frame takes the left columns while the outgoing one still
      // holds the right — a real wipe, not a reveal over emptiness.
      const stepCount = Math.max(1, Math.min(WIPE_STEPS, target));
      for (let i = 1; i <= stepCount; i++) {
        const edge = Math.ceil((target * i) / stepCount);
        const composited = art.map((line, row) => {
          const incoming = sliceSpans(line, 0, edge);
          const outgoing = previous ? sliceSpans(previous[row] || [], edge, maxWidth) : [];
          const gap = Math.max(0, edge - incoming.reduce((w, sp) => w + displayWidth(sp.t), 0));
          return [...incoming, ...(gap ? [{ t: ' '.repeat(gap) }] : []), ...outgoing];
        });
        steps.push({ lines: drawFrame(composited, suffixRow, innerWidth, code), ms: WIPE_STEP_MS });
      }
    } else if (transition === 'typewriter' && target > 0) {
      const width = Math.min(widthOf(art), maxWidth);
      for (let w = 1; w <= width; w++) {
        steps.push({ lines: drawFrame(art.map((l) => sliceSpans(l, 0, w)), suffixRow, innerWidth, code), ms: TYPE_STEP_MS });
      }
    }

    steps.push({ lines: drawFrame(art, suffixRow, innerWidth, code), ms: frame.hold_ms || DEFAULT_HOLD_MS });
  });

  return { steps, loop };
}

/**
 * Plays a timeline into a LineRenderer. Single-shot by default; `loop` repeats
 * until stop(). Stopping is immediate and idempotent — the FSM calls it the
 * instant the agent's answer lands, and nothing may outlive that.
 */
class Animator {
  constructor(renderer, { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    this.renderer = renderer;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.timer = null;
    this.stopped = false;
  }

  /** Draw `steps` in order. Returns true if the first frame was drawn. */
  play({ steps, loop }) {
    this.stopped = false;
    if (!steps || !steps.length) return false;

    let i = 0;
    const tick = () => {
      if (this.stopped) return;
      const step = steps[i];
      this.renderer.render(step.lines);
      i++;
      if (i >= steps.length) {
        if (!loop) return;
        i = 0;
      }
      if (step.ms > 0) {
        this.timer = this.setTimeoutFn(tick, step.ms);
        if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
      }
    };

    const drawn = this.renderer.render(steps[0].lines);
    if (!drawn) return false;
    i = 1;
    if (steps.length > 1 || loop) {
      this.timer = this.setTimeoutFn(tick, steps[0].ms || DEFAULT_HOLD_MS);
      if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    }
    return true;
  }

  /** Halt playback and erase. Safe to call at any time, any number of times. */
  stop() {
    this.stopped = true;
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.renderer.clear();
  }
}

module.exports = {
  LineRenderer, formatAd, revealFrames, buildTimeline, Animator, colorCode, COLOR_CODES, FG_CODES,
  REVEAL_STEPS, REVEAL_FRAME_MS,
  MAX_ROWS_TEXT, MAX_ROWS_ART, MIN_COLS_ART, MIN_ROWS_ART,
};

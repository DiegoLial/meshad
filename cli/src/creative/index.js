/**
 * Vendored copy of packages/creative — the creative contract for coloured art.
 *
 * The CLI must be installable standalone (`npm install -g` from a git
 * subdirectory, no monorepo checkout required), so it can't depend on
 * packages/creative via a `file:` path. The BODY of this file and
 * packages/creative/index.js must stay identical — test/creative-sync.test.js
 * enforces that, and `make sync-vendored` performs it.
 *
 * The load-bearing decision: a creative NEVER carries an ANSI escape sequence.
 * It carries *spans* — {t, fg, bg, bold, underline} — and the client synthesizes
 * the escape itself from these closed enums. An advertiser therefore has no
 * channel through which to reach the terminal's cursor, screen, palette or
 * hyperlinks: the bytes that do the styling are written by our code, from our
 * table, never by theirs.
 */
'use strict';

/** Foreground SGR codes. `dim` is an attribute, kept here as a color name for
 *  backward compatibility with the pre-span `creatives.color` column. */
const FG_CODES = {
  dim: '2',
  black: '30', red: '31', green: '32', yellow: '33',
  blue: '34', magenta: '35', cyan: '36', white: '37',
  bright_black: '90', bright_red: '91', bright_green: '92', bright_yellow: '93',
  bright_blue: '94', bright_magenta: '95', bright_cyan: '96', bright_white: '97',
};

/** Background SGR codes. Same closed set, offset to the 40/100 ranges. */
const BG_CODES = {
  black: '40', red: '41', green: '42', yellow: '43',
  blue: '44', magenta: '45', cyan: '46', white: '47',
  bright_black: '100', bright_red: '101', bright_green: '102', bright_yellow: '103',
  bright_blue: '104', bright_magenta: '105', bright_cyan: '106', bright_white: '107',
};

const FG_NAMES = Object.keys(FG_CODES);
const BG_NAMES = Object.keys(BG_CODES);

/** Only these attributes exist. No blink, no reverse, no conceal, no strikethrough. */
const ATTR_CODES = { bold: '1', underline: '4' };

/** Every control character, DEL included — identical to the moderation rule. */
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

/** Art is bounded so an ad can never take the screen. See render.js for the
 *  matching client-side ceiling; these are the contract, that is the backstop. */
const MAX_ART_LINES = 5;        // + 1 mandatory sponsored/CTA row = 6 rendered rows
const MAX_FRAMES = 12;          // an animated creative is a short loop, not a video

/**
 * Minimum time a frame stays on screen. This is a SAFETY floor, not a style
 * choice: rapid full-colour changes in the visual field can trigger seizures in
 * photosensitive people, and WCAG draws the line at three flashes per second.
 * 400ms keeps any loop at or below 2.5 changes/sec with margin. It is enforced
 * at moderation, so no advertiser can ship a strobing terminal.
 */
const MIN_HOLD_MS = 400;
const MAX_HOLD_MS = 5000;
const DEFAULT_HOLD_MS = 900;

/** Transitions are rendered by the client from the frames it already has. */
const TRANSITIONS = ['cut', 'wipe', 'typewriter'];
const MAX_SPANS_PER_LINE = 24;
const MAX_LINE_WIDTH = 78;      // columns, measured by displayWidth (not .length)
const MAX_SPAN_TEXT = 78;

const ESC = '\x1b';

/* ── display width ────────────────────────────────────────────────────────── */

/**
 * Zero-width code points: combining marks, ZWJ, variation selectors and the
 * other joiners that ride along with a base character rather than occupying a
 * cell of their own.
 */
function isZeroWidth(cp) {
  return (
    cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f) ||   // combining diacritical marks
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||   // combining marks for symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) ||   // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)    // variation selectors supplement
  );
}

/**
 * Code points that occupy two terminal cells: East Asian Wide/Fullwidth, plus
 * the emoji blocks that terminals render double-width. Getting this wrong is
 * what silently misaligns a box border, so it is worth the table.
 */
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) ||   // Hiragana .. CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6b) ||
    (cp >= 0xff01 && cp <= 0xff60) ||   // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji: symbols & pictographs, emoticons
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // transport & map
    (cp >= 0x1f900 && cp <= 0x1f9ff) || // supplemental symbols & pictographs
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

/**
 * Width of `str` in terminal columns. Counts grapheme clusters (so a ZWJ emoji
 * family is one unit), then charges each cluster by its base code point.
 * Box drawing and padding must use this, never String#length.
 */
function displayWidth(str) {
  const s = String(str ?? '');
  const clusters = SEGMENTER ? [...SEGMENTER.segment(s)].map((g) => g.segment) : [...s];
  let width = 0;
  for (const cluster of clusters) {
    const cp = cluster.codePointAt(0);
    if (cp === undefined || isZeroWidth(cp)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Truncate `str` to at most `maxWidth` terminal columns, never splitting a
 * grapheme cluster in half (which would emit a lone surrogate or orphan a
 * combining mark).
 */
function truncateToWidth(str, maxWidth) {
  const s = String(str ?? '');
  if (maxWidth <= 0) return '';
  if (displayWidth(s) <= maxWidth) return s;
  const clusters = SEGMENTER ? [...SEGMENTER.segment(s)].map((g) => g.segment) : [...s];
  let width = 0;
  let out = '';
  for (const cluster of clusters) {
    const cp = cluster.codePointAt(0);
    const w = cp === undefined || isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1;
    if (width + w > maxWidth) break;
    out += cluster;
    width += w;
  }
  return out;
}

/* ── validation ───────────────────────────────────────────────────────────── */

/**
 * Validate one span against the closed allowlist.
 * @returns {string[]} reasons, empty when valid
 */
function validateSpan(span, where) {
  const reasons = [];
  if (span === null || typeof span !== 'object' || Array.isArray(span)) {
    return [`${where}_not_an_object`];
  }
  for (const key of Object.keys(span)) {
    if (!['t', 'fg', 'bg', 'bold', 'underline'].includes(key)) {
      reasons.push(`${where}_unknown_field:${key}`);
    }
  }
  if (typeof span.t !== 'string') reasons.push(`${where}_text_not_a_string`);
  else {
    if (span.t.length === 0) reasons.push(`${where}_text_empty`);
    if (span.t.length > MAX_SPAN_TEXT) reasons.push(`${where}_text_too_long`);
    if (CONTROL_CHARS_RE.test(span.t)) reasons.push(`${where}_control_characters`);
  }
  if (span.fg !== undefined && !FG_NAMES.includes(span.fg)) reasons.push(`${where}_fg_not_allowed`);
  if (span.bg !== undefined && !BG_NAMES.includes(span.bg)) reasons.push(`${where}_bg_not_allowed`);
  if (span.bold !== undefined && typeof span.bold !== 'boolean') reasons.push(`${where}_bold_not_a_boolean`);
  if (span.underline !== undefined && typeof span.underline !== 'boolean') {
    reasons.push(`${where}_underline_not_a_boolean`);
  }
  return reasons;
}

/**
 * Validate a full `ascii_panel` body: an array of lines, each an array of spans.
 * @param {{ lines: Array<Array<object>> }} body
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function validateArt(body) {
  const reasons = [];
  const lines = body && body.art_lines;
  if (!Array.isArray(lines)) return { ok: false, reasons: ['art_lines_not_an_array'] };
  if (lines.length === 0) reasons.push('art_empty');
  if (lines.length > MAX_ART_LINES) reasons.push('art_too_many_lines');

  lines.slice(0, MAX_ART_LINES).forEach((line, i) => {
    if (!Array.isArray(line)) {
      reasons.push(`art_line_${i}_not_an_array`);
      return;
    }
    if (line.length > MAX_SPANS_PER_LINE) reasons.push(`art_line_${i}_too_many_spans`);
    let width = 0;
    line.forEach((span, j) => {
      for (const r of validateSpan(span, `art_line_${i}_span_${j}`)) reasons.push(r);
      if (span && typeof span.t === 'string') width += displayWidth(span.t);
    });
    if (width > MAX_LINE_WIDTH) reasons.push(`art_line_${i}_too_wide`);
  });

  return { ok: reasons.length === 0, reasons };
}

/**
 * Validate an animated creative: `frames`, each a full art payload plus how long
 * it holds. A single-frame creative may still use the flat `art_lines` shape;
 * this normalizes both.
 *
 * Two structural rules exist for reasons the renderer cannot recover from:
 *  - every frame must have the SAME number of lines, because the footer's height
 *    is fixed when the ad is drawn and `clear()` erases exactly that many rows.
 *    A frame that grew mid-loop would leave residue on the developer's screen.
 *  - hold_ms has a floor (see MIN_HOLD_MS) — a photosensitivity guard, not taste.
 *
 * @returns {{ ok: boolean, reasons: string[], frames: Array<{art_lines, hold_ms}> }}
 */
function validateFrames(body) {
  const reasons = [];

  if (body && Array.isArray(body.frames)) {
    const frames = body.frames;
    if (frames.length === 0) reasons.push('frames_empty');
    if (frames.length > MAX_FRAMES) reasons.push('frames_too_many');

    if (body.transition !== undefined && !TRANSITIONS.includes(body.transition)) {
      reasons.push('transition_not_allowed');
    }
    if (body.loop !== undefined && typeof body.loop !== 'boolean') reasons.push('loop_not_a_boolean');

    let lineCount = null;
    frames.slice(0, MAX_FRAMES).forEach((frame, i) => {
      if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
        reasons.push(`frame_${i}_not_an_object`);
        return;
      }
      for (const key of Object.keys(frame)) {
        if (!['art_lines', 'hold_ms'].includes(key)) reasons.push(`frame_${i}_unknown_field:${key}`);
      }

      const verdict = validateArt(frame);
      for (const r of verdict.reasons) reasons.push(`frame_${i}_${r}`);

      if (Array.isArray(frame.art_lines)) {
        if (lineCount === null) lineCount = frame.art_lines.length;
        else if (frame.art_lines.length !== lineCount) reasons.push(`frame_${i}_line_count_differs`);
      }

      if (frame.hold_ms !== undefined) {
        if (typeof frame.hold_ms !== 'number' || !Number.isFinite(frame.hold_ms)) {
          reasons.push(`frame_${i}_hold_ms_not_a_number`);
        } else if (frame.hold_ms < MIN_HOLD_MS) {
          reasons.push(`frame_${i}_hold_ms_below_minimum`);
        } else if (frame.hold_ms > MAX_HOLD_MS) {
          reasons.push(`frame_${i}_hold_ms_above_maximum`);
        }
      }
    });

    const normalized = frames.slice(0, MAX_FRAMES).map((f) => ({
      art_lines: (f && f.art_lines) || [],
      hold_ms: (f && typeof f.hold_ms === 'number') ? f.hold_ms : DEFAULT_HOLD_MS,
    }));
    return { ok: reasons.length === 0, reasons, frames: normalized };
  }

  // Flat, single-frame shape.
  const verdict = validateArt(body);
  return {
    ok: verdict.ok,
    reasons: verdict.reasons,
    frames: [{ art_lines: (body && body.art_lines) || [], hold_ms: DEFAULT_HOLD_MS }],
  };
}

/** Every span of text in a creative, flat — what moderation reads. */
function collectText(body) {
  const framesIn = body && Array.isArray(body.frames) ? body.frames : [body];
  const out = [];
  for (const frame of framesIn) {
    const lines = frame && Array.isArray(frame.art_lines) ? frame.art_lines : [];
    for (const line of lines) {
      for (const span of Array.isArray(line) ? line : []) {
        if (span && typeof span.t === 'string') out.push(span.t);
      }
    }
  }
  return out;
}

/* ── rendering ────────────────────────────────────────────────────────────── */

/**
 * The SGR sequence for a span, built from our tables only. Returns '' when the
 * span carries no styling, so an unstyled span costs no bytes.
 */
function spanEscape(span) {
  const codes = [];
  if (span.bold) codes.push(ATTR_CODES.bold);
  if (span.underline) codes.push(ATTR_CODES.underline);
  if (span.fg && FG_CODES[span.fg]) codes.push(FG_CODES[span.fg]);
  if (span.bg && BG_CODES[span.bg]) codes.push(BG_CODES[span.bg]);
  return codes.length ? `${ESC}[${codes.join(';')}m` : '';
}

/**
 * The sub-array of spans covering terminal columns [from, to), splitting a span
 * down the middle when the boundary falls inside it. Styling is carried onto the
 * fragment, so a span cut in half keeps its colour on both sides.
 *
 * This is what makes a real wipe possible: the incoming frame occupies the left
 * columns while the outgoing frame still occupies the right ones.
 */
function sliceSpans(line, from, to = Infinity) {
  if (!Array.isArray(line)) return [];
  const out = [];
  let col = 0;
  for (const span of line) {
    if (!span || typeof span.t !== 'string') continue;
    const w = displayWidth(span.t);
    const start = col;
    const end = col + w;
    col = end;
    if (end <= from || start >= to) continue;

    if (start >= from && end <= to) {
      out.push(span);
      continue;
    }
    // Partial overlap: cut the text to the visible column range.
    const dropLeft = Math.max(0, from - start);
    const keepWidth = Math.min(end, to) - Math.max(start, from);
    let text = span.t;
    if (dropLeft > 0) {
      const head = truncateToWidth(text, dropLeft);
      text = text.slice(head.length);
    }
    text = truncateToWidth(text, keepWidth);
    if (text.length) out.push({ ...span, t: text });
  }
  return out;
}

/**
 * Render one line of spans to a styled string, clamped to `maxWidth` columns.
 * Every span is reset immediately after it is written, so no style can leak into
 * the developer's prompt if the trailing reset were ever lost.
 *
 * Invalid spans are dropped rather than thrown on: this runs on the render path,
 * where the contract is fail-closed — show less, never crash the host agent.
 */
function renderLine(line, maxWidth = MAX_LINE_WIDTH) {
  if (!Array.isArray(line)) return '';
  let out = '';
  let width = 0;
  for (const span of line) {
    if (!span || typeof span.t !== 'string' || CONTROL_CHARS_RE.test(span.t)) continue;
    const remaining = maxWidth - width;
    if (remaining <= 0) break;
    const text = truncateToWidth(span.t, remaining);
    if (text.length === 0) continue;
    const esc = spanEscape(span);
    out += esc ? `${esc}${text}${ESC}[0m` : text;
    width += displayWidth(text);
  }
  return out;
}

module.exports = {
  FG_CODES, BG_CODES, FG_NAMES, BG_NAMES, ATTR_CODES,
  MAX_ART_LINES, MAX_SPANS_PER_LINE, MAX_LINE_WIDTH, MAX_SPAN_TEXT,
  MAX_FRAMES, MIN_HOLD_MS, MAX_HOLD_MS, DEFAULT_HOLD_MS, TRANSITIONS,
  CONTROL_CHARS_RE,
  displayWidth, truncateToWidth,
  validateSpan, validateArt, validateFrames, collectText, sliceSpans,
  spanEscape, renderLine,
};

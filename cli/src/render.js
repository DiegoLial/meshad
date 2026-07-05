'use strict';

/**
 * Footer renderer — 1 to 5 rows depending on format. Fail-closed: any
 * problem (no TTY, weird terminal, write error) means NO ad — never an
 * exception for the caller, never a corrupted screen.
 *
 * Render: save cursor (ESC 7) → jump to the last N rows → write each line
 * → restore (ESC 8). Clear: same dance, erase exactly the N rows that were
 * last drawn (tracked in `activeHeight`) — both are a single synchronous
 * write per call, clear completes in well under 100ms.
 */

const ESC = '\x1b';
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;

const COLOR_CODES = { dim: '2', green: '32', cyan: '36', magenta: '35', yellow: '33', blue: '34', red: '31' };

function colorCode(color) {
  return COLOR_CODES[color] || COLOR_CODES.dim;
}

/** Strip control/newline characters and clamp length — never trust ad content blindly. */
function sanitizeLine(s, maxLen) {
  return String(s ?? '')
    .replace(/[\r\n\x00-\x08\x0b-\x1f]/g, ' ')
    .slice(0, Math.max(0, maxLen));
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
      const height = Math.min(lines.length, rows - 1, 5);
      if (height <= 0) return false;

      let out = SAVE;
      for (let i = 0; i < height; i++) {
        const targetRow = rows - height + 1 + i;
        const raw = sanitizeAnsiLine(String(lines[i] ?? ''), cols - 1);
        out += `${ESC}[${targetRow};1H${ESC}[2K${raw}${ESC}[0m`;
      }
      out += RESTORE;
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
      let out = SAVE;
      for (let i = 0; i < this.activeHeight; i++) {
        out += `${ESC}[${rows - this.activeHeight + 1 + i};1H${ESC}[2K`;
      }
      out += RESTORE;
      this.stream.write(out);
    } catch {
      /* fail-closed: nothing to do */
    }
    this.active = false;
    this.activeHeight = 0;
  }
}

/**
 * A line that may already carry a leading ANSI color escape (from formatAd)
 * — sanitize the human-readable text but preserve the leading \x1b[..m code.
 */
function sanitizeAnsiLine(line, maxLen) {
  const m = /^(\x1b\[[0-9;]*m)([\s\S]*)$/.exec(line);
  if (!m) return sanitizeLine(line, maxLen);
  return m[1] + sanitizeLine(m[2], maxLen);
}

/**
 * Render an ad into 1-5 already-colored, ANSI-ready lines, per its format:
 *   text_line  — one line: emoji + text + cta + sponsored label.
 *   text_block — 2-4 lines: content lines, then the cta/sponsored line.
 *   rich_panel — a bordered box (┌─┐ / │ │ / └─┘) around the same content.
 * The `sponsored` label and pause hint are non-negotiable and always present.
 */
function formatAd(ad, cols = 80) {
  const r = (ad && ad.render) || {};
  const code = colorCode(r.color);
  const emojiPrefix = r.emoji ? `${r.emoji} ` : '';
  const suffix = `${r.cta || ''} · sponsored · (meshad pause)`;
  const maxLen = Math.max(20, cols - 1);
  const contentLines = (Array.isArray(r.lines) && r.lines.length ? r.lines : [r.text || '']).slice(0, 3);
  const wrap = (s) => `\x1b[${code}m${s}`;

  const format = ad && ad.format;

  if (format === 'rich_panel' && cols >= 40) {
    const rawRows = [...contentLines.map((l, i) => `${i === 0 ? emojiPrefix : ''}${l}`), suffix];
    const innerWidth = Math.min(maxLen - 4, Math.max(...rawRows.map((l) => l.length)) + 0);
    const pad = (s) => {
      const clipped = sanitizeLine(s, innerWidth);
      return ` ${clipped}${' '.repeat(Math.max(0, innerWidth - clipped.length))} `;
    };
    const top = `┌${'─'.repeat(innerWidth + 2)}┐`;
    const bottom = `└${'─'.repeat(innerWidth + 2)}┘`;
    const rows = [top, ...rawRows.map((l) => `│${pad(l)}│`), bottom];
    return rows.map(wrap);
  }

  if (format === 'text_block' || (format === 'rich_panel' /* too narrow: degrade */)) {
    const rows = [...contentLines.map((l, i) => `${i === 0 ? emojiPrefix : ''}${l}`), suffix].map((l) =>
      sanitizeLine(l, maxLen),
    );
    return rows.map(wrap);
  }

  // text_line (default, and the fallback for any unknown future format)
  const line = sanitizeLine(`${emojiPrefix}${contentLines[0] || ''}  ${suffix}`, maxLen);
  return [wrap(line)];
}

module.exports = { LineRenderer, formatAd, colorCode, COLOR_CODES };

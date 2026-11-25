'use strict';

/**
 * TTY shell for PlaySession: alternate screen, raw keys, a fixed-rate loop.
 * Reads ONLY its own stdin (this process's controlling terminal) — it never
 * touches the agent's input, and the agent's output never reaches it.
 */

const { parseKeys } = require('./session');
const { RENDER_BEAT_MS } = require('./bridge');
const { rowsPatch, guardTerminal } = require('./term');

const ESC = '\x1b';
const POLL_EVERY_MS = 250; // bridge poll
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;

/**
 * Run the session until it is done. Resolves once the terminal is restored.
 * `renderSignal` ({beat(), clear()}) tells `meshad run` this pane is drawing:
 * beaten every RENDER_BEAT_MS while the alternate screen is up and the game
 * is not frozen, cleared on the way out. Best effort, never throws.
 * The loop runs at `session.tickMs`, re-read every tick: each engine has its own
 * fixed rate (runner 50ms, snake 120ms…), and a menu → game switch changes it.
 * @returns {Promise<void>}
 */
function runTty(session, { stdin = process.stdin, stdout = process.stdout, renderSignal = null } = {}) {
  return new Promise((resolve) => {
    let last = []; // rows currently on screen; only changed rows are rewritten
    let closed = false;
    let timer = null;
    const start = Date.now();
    let due = start + session.tickMs;
    let lastPoll = start;
    let lastBeat = start;

    const draw = () => {
      const cols = stdout.columns || 80;
      const rows = stdout.rows || 24;
      const lines = session.render(cols, rows);
      const patch = rowsPatch(last, lines);
      if (!patch) return; // unchanged frame: write nothing
      const stale = last.length > lines.length ? `${ESC}[${lines.length + 1};1H${ESC}[J` : '';
      last = lines;
      stdout.write(`${SYNC_ON}${patch}${stale}${SYNC_OFF}`); // one atomic frame: terminals that know mode 2026 never show half a repaint
    };

    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdout.off('resize', onResize);
      release();
      restore();
      resolve();
    };
    const signal = (fn) => { try { if (renderSignal) renderSignal[fn](); } catch { /* best effort */ } };
    let restored = false;
    const restore = () => { // idempotent: runs on close, on exit, on signals and after an uncaught error
      if (restored) return;
      restored = true;
      signal('clear');
      try { stdin.setRawMode(false); } catch { /* not a TTY anymore */ }
      try { stdin.pause(); } catch { /* already gone */ }
      stdout.write(`${ESC}[?25h${ESC}[?1049l`);
    };
    const onData = (chunk) => {
      for (const k of parseKeys(chunk)) session.key(k);
      if (session.done) close();
      else draw();
    };
    const onResize = () => { last = []; stdout.write(`${ESC}[2J`); draw(); };
    const onSignal = () => { session.done = true; close(); };
    const release = guardTerminal({ restore, onSignal });

    stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdout.on('resize', onResize);

    const loop = () => {
      if (closed) return;
      const now = Date.now();
      if (now - lastPoll >= POLL_EVERY_MS) { session.poll(); lastPoll = now; }
      session.tick();
      draw();
      if (now - lastBeat >= RENDER_BEAT_MS && !closed) {
        lastBeat = now;
        if (session.gate === 'frozen') signal('clear'); else signal('beat');
      }
      due += session.tickMs;
      if (due < now - 1000) due = now + session.tickMs; // suspended (laptop sleep…): don't replay the missed ticks
      timer = setTimeout(loop, Math.max(0, due - Date.now()));
    };
    timer = setTimeout(loop, session.tickMs);
    draw();
    signal('beat');
  });
}

module.exports = { runTty };

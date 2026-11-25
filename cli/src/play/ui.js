'use strict';

/**
 * TTY shell for PlaySession: alternate screen, raw keys, a fixed-rate loop.
 * Reads ONLY its own stdin (this process's controlling terminal) — it never
 * touches the agent's input, and the agent's output never reaches it.
 */

const { parseKeys } = require('./session');
const { RENDER_BEAT_MS } = require('./bridge');
const { rowsPatch } = require('./term');

const ESC = '\x1b';
const POLL_EVERY_MS = 250; // bridge poll

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
      stdout.write(`${patch}${stale}`);
    };

    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdout.off('resize', onResize);
      process.off('exit', restore);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      restore();
      resolve();
    };
    const signal = (fn) => { try { if (renderSignal) renderSignal[fn](); } catch { /* best effort */ } };
    const restore = () => {
      signal('clear');
      try { stdin.setRawMode(false); } catch { /* not a TTY anymore */ }
      stdin.pause();
      stdout.write(`${ESC}[?25h${ESC}[?1049l`);
    };
    const onData = (chunk) => {
      for (const k of parseKeys(chunk)) session.key(k);
      if (session.done) close();
      else draw();
    };
    const onResize = () => { last = []; stdout.write(`${ESC}[2J`); draw(); };
    const onSignal = () => { session.done = true; close(); };

    stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    process.on('exit', restore); // last resort: never leave the user in the alt screen
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);

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

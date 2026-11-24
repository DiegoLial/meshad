'use strict';

/**
 * TTY shell for PlaySession: alternate screen, raw keys, a fixed-rate loop.
 * Reads ONLY its own stdin (this process's controlling terminal) — it never
 * touches the agent's input, and the agent's output never reaches it.
 */

const { parseKeys } = require('./session');
const { TICK_MS } = require('./runner');
const { RENDER_BEAT_MS } = require('./bridge');

const ESC = '\x1b';
const POLL_EVERY_TICKS = 5; // bridge poll ≈ every 250ms
const RENDER_EVERY_TICKS = Math.max(1, Math.round(RENDER_BEAT_MS / TICK_MS));

/**
 * Run the session until it is done. Resolves once the terminal is restored.
 * `renderSignal` ({beat(), clear()}) tells `meshad run` this pane is drawing:
 * beaten every RENDER_EVERY_TICKS while the alternate screen is up and the game
 * is not frozen, cleared on the way out. Best effort, never throws.
 * @returns {Promise<void>}
 */
function runTty(session, { stdin = process.stdin, stdout = process.stdout, renderSignal = null } = {}) {
  return new Promise((resolve) => {
    let last = '';
    let ticks = 0;
    let closed = false;

    const draw = () => {
      const cols = stdout.columns || 80;
      const rows = stdout.rows || 24;
      const lines = session.render(cols, rows);
      const frame = lines.join('\n');
      if (frame === last) return;
      last = frame;
      stdout.write(`${ESC}[H${lines.map((l) => `${l}${ESC}[K`).join('\n')}${ESC}[J`);
    };

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
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
    const onResize = () => { last = ''; draw(); };
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

    const timer = setInterval(() => {
      if (++ticks % POLL_EVERY_TICKS === 0) session.poll();
      session.tick();
      draw();
      if (ticks % RENDER_EVERY_TICKS === 0 && !closed) {
        if (session.gate === 'frozen') signal('clear'); else signal('beat');
      }
    }, TICK_MS);
    draw();
    signal('beat');
  });
}

module.exports = { runTty };

'use strict';

/**
 * Tiny zero-dep TTY widgets: selectPrompt, multiSelectPrompt, textPrompt.
 *
 * Every widget takes injectable `{ stdin, stdout }` (defaults: process.stdin /
 * process.stdout) so tests can drive them with PassThrough streams. Raw mode,
 * the cursor and the drawn block are always restored on the way out, however
 * the prompt ends. Cancel (Esc / Ctrl-C) resolves `null`; nothing here ever
 * throws on user input and nothing touches the network.
 */

const i18n = require('./i18n');
const { sanitizeAnsiLine } = require('./render');
const { displayWidth } = require('./creative');
const { autoStyle } = require('./play/term');

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CSI_RE = /^\x1b(?:\[|O)([0-9;]*)([A-Za-z~])/;
const CSI_NAMES = { A: 'up', B: 'down', C: 'right', D: 'left' };

/** Decode one stdin chunk into key events (a paste or fast typing may carry several). */
function parseKeys(chunk) {
  const s = String(chunk);
  const keys = [];
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (ch === '\x1b') {
      const m = CSI_RE.exec(s.slice(i));
      if (m) {
        keys.push({ name: CSI_NAMES[m[2]] || 'other' });
        i += m[0].length;
      } else {
        keys.push({ name: 'escape' });
        i += 1;
      }
      continue;
    }
    i += 1;
    if (ch === '\r') {
      keys.push({ name: 'enter' });
      if (s[i] === '\n') i += 1; // CRLF is one Enter
    } else if (ch === '\n') keys.push({ name: 'enter' });
    else if (ch === '\x03') keys.push({ name: 'ctrl-c' });
    else if (ch === '\x7f' || ch === '\b') keys.push({ name: 'backspace' });
    else if (ch === ' ') keys.push({ name: 'space', ch });
    else if (ch >= ' ') keys.push({ name: 'char', ch });
    else keys.push({ name: 'other' });
  }
  return keys;
}

/**
 * Shared raw-mode session. `view()` returns the lines to draw; `onKey(key)`
 * returns `{ value }` to finish or undefined to keep going (and redraw).
 */
function runSession({ stdin, stdout, env }, { hideCursor, view, onKey }) {
  const inp = stdin || process.stdin;
  const out = stdout || process.stdout;
  const st = autoStyle(env || process.env, out); // colour depth from NO_COLOR / TTY / TERM / COLORTERM of THIS stream
  return new Promise((resolve, reject) => {
    const canRaw = typeof inp.setRawMode === 'function';
    const wasRaw = inp.isRaw === true;
    let drawn = 0;
    let finished = false;

    const erase = () => {
      if (drawn > 0) out.write(`\x1b[${drawn}A\r\x1b[J`);
      drawn = 0;
    };
    const draw = () => {
      erase();
      // One row per line, never wider than the pane: a wrapped line would make
      // `\x1b[${drawn}A` undercount and smear the redraw in a narrow split.
      const maxWidth = Math.max(1, (out.columns || 80) - 1);
      const lines = view(st).map((l) => sanitizeAnsiLine(l, maxWidth).text);
      out.write(`${lines.join('\n')}\n`);
      drawn = lines.length;
    };
    const onExit = () => out.write(SHOW_CURSOR);

    const cleanup = () => {
      finished = true;
      inp.removeListener('data', onData);
      inp.removeListener('end', onEnd);
      process.removeListener('exit', onExit);
      erase();
      if (hideCursor) out.write(SHOW_CURSOR);
      if (canRaw) inp.setRawMode(wasRaw);
      inp.pause();
    };
    const done = (value) => {
      if (finished) return;
      cleanup();
      resolve(value);
    };
    function onEnd() { done(null); }
    function onData(chunk) {
      if (finished) return;
      try {
        for (const key of parseKeys(chunk)) {
          const r = onKey(key);
          if (r) return done(r.value);
        }
        draw();
      } catch (err) {
        if (!finished) cleanup();
        reject(err);
      }
    }

    if (hideCursor) {
      out.write(HIDE_CURSOR);
      process.once('exit', onExit);
    }
    if (canRaw) inp.setRawMode(true);
    inp.on('data', onData);
    inp.on('end', onEnd);
    inp.resume();
    try {
      draw();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

function header(st, title, subtitle) {
  const lines = [];
  if (title) lines.push(`  ${st.gradient(`▍${title}`, 'cyan', 'magenta', { bold: true })}`);
  if (subtitle) lines.push(`  ${st.paint(subtitle, { fg: 'mute' })}`);
  if (lines.length) lines.push('');
  return lines;
}

const enabled = (o) => !o.disabled;
const widthOf = (stdout) => ((stdout || process.stdout).columns || 80) - 1;

/** Index of the nearest enabled option from `from` going `step` (±1), wrapping; -1 if none. */
function nextEnabled(options, from, step) {
  const n = options.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    if (enabled(options[i])) return i;
  }
  return -1;
}

/** One option row. The active row is a highlighted bar in colour, `❯ label` in plain mode. */
function optionText(st, o, active, mark, width) {
  const hint = o.hint ? `  ${st.paint(o.hint, { fg: 'mute' })}` : '';
  if (o.disabled) return `    ${st.paint(`${mark}${o.label}${o.hint ? `  ${o.hint}` : ''}`, { fg: 'line' })}`;
  if (!active) return `    ${mark}${o.label}${hint}`;
  if (!st.on) return `  ${'❯'} ${mark}${o.label}${o.hint ? `  ${o.hint}` : ''}`;
  const plain = `  ❯ ${mark}${o.label}${o.hint ? `  ${o.hint}` : ''}`;
  const pad = ' '.repeat(Math.max(0, Math.min(width, 64) - displayWidth(plain)));
  const hintOn = o.hint ? `  ${st.paint(o.hint, { fg: 'sky', bg: 'panel' })}` : '';
  return `${st.paint('  ❯ ', { fg: 'cyan', bg: 'panel', bold: true })}${st.paint(`${mark}${o.label}`, { fg: 'ink', bg: 'panel', bold: true })}${hintOn}${st.paint(pad, { bg: 'panel' })}`;
}

/**
 * Single choice: ↑/↓ move (disabled items are skipped), Enter picks, Esc/Ctrl-C cancels.
 * @returns {Promise<any|null>} the option's `value`, or null on cancel
 */
async function selectPrompt({ title, subtitle, options = [], initialIndex = 0, stdin, stdout, env } = {}) {
  if (!options.some(enabled)) return null;
  let idx = Math.min(Math.max(initialIndex | 0, 0), options.length - 1);
  if (!enabled(options[idx])) idx = nextEnabled(options, idx, 1);

  return runSession({ stdin, stdout, env }, {
    hideCursor: true,
    view: (st) => [
      ...header(st, title, subtitle),
      ...options.map((o, i) => optionText(st, o, i === idx, '', widthOf(stdout))),
      '',
      `  ${st.paint(i18n.t('ui.hint.select'), { fg: 'mute' })}`,
    ],
    onKey: (key) => {
      if (key.name === 'up') idx = nextEnabled(options, idx, -1);
      else if (key.name === 'down') idx = nextEnabled(options, idx, 1);
      else if (key.name === 'enter') return { value: options[idx].value };
      else if (key.name === 'escape' || key.name === 'ctrl-c') return { value: null };
      return undefined;
    },
  });
}

/**
 * Multiple choice: ↑/↓ move, Space toggles [x]/[ ], Enter confirms, Esc/Ctrl-C cancels.
 * @returns {Promise<any[]|null>} chosen values in option order, or null on cancel
 */
async function multiSelectPrompt({ title, subtitle, options = [], selected = [], stdin, stdout, env } = {}) {
  if (options.length === 0) return [];
  const chosen = new Set(selected.filter((v) => options.some((o) => o.value === v && enabled(o))));
  let idx = options.findIndex(enabled);
  if (idx < 0) idx = 0;

  return runSession({ stdin, stdout, env }, {
    hideCursor: true,
    view: (st) => [
      ...header(st, title, subtitle),
      ...options.map((o, i) => optionText(st, o, i === idx, chosen.has(o.value) ? st.paint('[x] ', { fg: 'lime', bg: i === idx ? 'panel' : undefined, bold: true }) : '[ ] ', widthOf(stdout))),
      '',
      `  ${st.paint(i18n.t('ui.hint.multi'), { fg: 'mute' })}`,
    ],
    onKey: (key) => {
      if (key.name === 'up') idx = nextEnabled(options, idx, -1);
      else if (key.name === 'down') idx = nextEnabled(options, idx, 1);
      else if (key.name === 'space') {
        const o = options[idx];
        if (enabled(o)) {
          if (chosen.has(o.value)) chosen.delete(o.value);
          else chosen.add(o.value);
        }
      } else if (key.name === 'enter') return { value: options.filter((o) => chosen.has(o.value)).map((o) => o.value) };
      else if (key.name === 'escape' || key.name === 'ctrl-c') return { value: null };
      return undefined;
    },
  });
}

/**
 * Single-line text input. `validate(value)` returns an error string to reject
 * (shown inline, input stays open) or a falsy/true value to accept.
 * @returns {Promise<string|null>} the entered text, or null on cancel
 */
async function textPrompt({ title, placeholder = '', validate, stdin, stdout, env } = {}) {
  let value = '';
  let error = '';

  return runSession({ stdin, stdout, env }, {
    hideCursor: false,
    view: (st) => [
      ...header(st, title),
      `  ${st.paint('›', { fg: 'cyan', bold: true })} ${value || st.paint(placeholder, { fg: 'mute' })}`,
      error ? `  ${st.paint(error, { fg: 'red' })}` : '',
      `  ${st.paint(i18n.t('ui.hint.text'), { fg: 'mute' })}`,
    ],
    onKey: (key) => {
      if (key.name === 'escape' || key.name === 'ctrl-c') return { value: null };
      if (key.name === 'enter') {
        const verdict = validate ? validate(value) : null;
        if (typeof verdict === 'string' && verdict) error = verdict;
        else return { value };
      } else if (key.name === 'backspace') {
        value = Array.from(value).slice(0, -1).join('');
        error = '';
      } else if (key.name === 'char' || key.name === 'space') {
        value += key.ch;
        error = '';
      }
      return undefined;
    },
  });
}

module.exports = { selectPrompt, multiSelectPrompt, textPrompt, parseKeys };

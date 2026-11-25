'use strict';

/**
 * Tiny zero-dep TTY widgets: selectPrompt, multiSelectPrompt, topicSelectorPrompt, textPrompt.
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
const { autoStyle, guardTerminal } = require('./play/term');

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
    else if (ch === '\x0c') keys.push({ name: 'ctrl-l' });
    else if (ch === '\x01') keys.push({ name: 'ctrl-a' });
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
    // Idempotent: also runs from `exit`, SIGINT/SIGTERM/SIGHUP and an uncaught error, so a killed menu never leaves a hidden cursor or raw mode behind.
    const restore = () => {
      if (hideCursor) out.write(SHOW_CURSOR);
      try { if (canRaw) inp.setRawMode(wasRaw); } catch { /* not a TTY anymore */ }
    };
    const release = guardTerminal({ restore, onSignal: () => done(null) });

    const cleanup = () => {
      finished = true;
      inp.removeListener('data', onData);
      inp.removeListener('end', onEnd);
      release();
      erase();
      restore();
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

    if (hideCursor) out.write(HIDE_CURSOR);
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
  const hintOn = o.hint ? `${st.paint('  ', { bg: 'panel' })}${st.paint(o.hint, { fg: 'sky', bg: 'panel' })}` : ''; // the two spaces before the hint carry the bar colour too: no black gap
  return `${st.paint('  ❯ ', { fg: 'cyan', bg: 'panel', bold: true })}${st.paint(`${mark}${o.label}`, { fg: 'ink', bg: 'panel', bold: true })}${hintOn}${st.paint(pad, { bg: 'panel' })}`;
}

/**
 * Single choice: ↑/↓ move (disabled items are skipped), Enter picks, Esc/Ctrl-C cancels.
 * `preview(option, style)` may return extra lines drawn under the list for the highlighted option.
 * @returns {Promise<any|null>} the option's `value`, or null on cancel
 */
async function selectPrompt({ title, subtitle, options = [], initialIndex = 0, preview = null, footer = null, stdin, stdout, env } = {}) {
  if (!options.some(enabled)) return null;
  let idx = Math.min(Math.max(initialIndex | 0, 0), options.length - 1);
  if (!enabled(options[idx])) idx = nextEnabled(options, idx, 1);

  return runSession({ stdin, stdout, env }, {
    hideCursor: true,
    view: (st) => [
      ...header(st, title, subtitle),
      ...options.map((o, i) => optionText(st, o, i === idx, '', widthOf(stdout))),
      ...(preview ? ['', ...preview(options[idx], st).map((l) => `  ${l}`)] : []),
      '',
      `  ${st.paint(footer || i18n.t('ui.hint.select'), { fg: 'mute' })}`,
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
 * Topic picker with live search (a multiSelectPrompt for long lists you filter by typing).
 * ↑/↓ move · Space toggle · type (letters, digits, `:`, a leading `/`) to filter · Backspace edits the filter ·
 * Esc clears the filter first, then cancels · Ctrl+L clears every selection · Ctrl+A selects what is shown · Enter confirms.
 * Selections survive filtering. `status` is a short line ("news: on") drawn above the list.
 * @returns {Promise<any[]|null>} chosen values in option order, or null on cancel
 */
async function topicSelectorPrompt({ title, subtitle, status = '', options = [], selected = [], stdin, stdout, env } = {}) {
  if (options.length === 0) return [];
  const { t } = i18n;
  const chosen = new Set(selected.filter((v) => options.some((o) => o.value === v && enabled(o))));
  let query = '';
  let idx = 0;
  const shown = () => {
    const q = query.toLowerCase();
    return options.filter((o) => enabled(o) && (!q || `${o.value} ${o.label}`.toLowerCase().includes(q)));
  };
  const visibleRows = () => Math.max(3, ((stdout || process.stdout).rows || 24) - 11);

  return runSession({ stdin, stdout, env }, {
    hideCursor: true,
    view: (st) => {
      const list = shown();
      idx = Math.min(idx, Math.max(0, list.length - 1));
      const max = visibleRows();
      const start = Math.min(Math.max(0, idx - max + 1), Math.max(0, list.length - max));
      const rowsShown = list.slice(start, start + max);
      const body = list.length === 0
        ? [`    ${st.paint(t('ui.search.none', { q: query }), { fg: 'amber' })}`]
        : rowsShown.map((o, i) => optionText(st, o, start + i === idx, chosen.has(o.value) ? st.paint('[x] ', { fg: 'lime', bg: start + i === idx ? 'panel' : undefined, bold: true }) : '[ ] ', widthOf(stdout)));
      const more = list.length > rowsShown.length ? `  ${st.paint(`${start + 1}-${start + rowsShown.length} / ${list.length}`, { fg: 'mute' })}` : '';
      return [
        ...header(st, title, subtitle),
        `  ${st.paint(t('ui.topics.count', { n: chosen.size, total: options.length }), { fg: chosen.size ? 'lime' : 'mute', bold: true })}${status ? `  ${st.paint(status, { fg: 'sky' })}` : ''}${more}`,
        `  ${st.paint('/', { fg: 'cyan', bold: true })} ${query ? st.paint(query, { fg: 'ink', bold: true }) : st.paint(t('ui.search.hint'), { fg: 'mute' })}`,
        '',
        ...body,
        '',
        `  ${st.paint(t('ui.hint.topics'), { fg: 'mute' })}`,
        `  ${st.paint(t('ui.hint.topics2'), { fg: 'mute' })}`,
      ];
    },
    onKey: (key) => {
      const list = shown();
      if (key.name === 'up') idx = list.length ? (idx - 1 + list.length) % list.length : 0;
      else if (key.name === 'down') idx = list.length ? (idx + 1) % list.length : 0;
      else if (key.name === 'space') {
        const o = list[idx];
        if (o) {
          if (chosen.has(o.value)) chosen.delete(o.value);
          else chosen.add(o.value);
        }
      } else if (key.name === 'ctrl-l') chosen.clear();
      else if (key.name === 'ctrl-a') for (const o of list) chosen.add(o.value);
      else if (key.name === 'backspace') { query = Array.from(query).slice(0, -1).join(''); idx = 0; }
      else if (key.name === 'char') {
        if (!(query === '' && key.ch === '/') && /^[\p{L}\p{N}:_.\/-]$/u.test(key.ch)) { query += key.ch; idx = 0; }
      } else if (key.name === 'enter') return { value: options.filter((o) => chosen.has(o.value)).map((o) => o.value) };
      else if (key.name === 'escape') {
        if (query) { query = ''; idx = 0; } else return { value: null };
      } else if (key.name === 'ctrl-c') return { value: null };
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

module.exports = { selectPrompt, multiSelectPrompt, topicSelectorPrompt, textPrompt, parseKeys };

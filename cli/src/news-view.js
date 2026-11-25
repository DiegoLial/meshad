'use strict';

/**
 * Full-screen headlines view (menu → Headlines, play picker → Headlines).
 *
 * Local-only: the list is the cached generic feed (news-cache.json) filtered by the
 * topics in interests.json, on this computer. Nothing here sends anything; the
 * only network use is the same anonymous GET /v1/news/feed that `meshad run --news`
 * already does, and only when the caller allows it (`fetch: true`, i.e. the main
 * menu — the play picker stays offline). Enter opens the (tracking-stripped, https-only) link in
 * the system browser via a detached launcher and marks it read locally (news-read.json, 0600).
 *
 * MESHAD_NEWS_FIXTURE=<file.json> — demos/screenshots ONLY: when set, items come
 * from that file instead of the cache. Not read anywhere in the production feed path.
 */

const fs = require('node:fs');
const config = require('./config');
const i18n = require('./i18n');
const interests = require('./interests');
const { NewsCache, sanitizeItems, filterMatchingItems } = require('./news');
const { parts, shortTopic } = require('./news-render');
const newsRead = require('./news-read');
const { cleanOpenUrl, openUrl: systemOpenUrl } = require('./news-open');
const { parseKeys } = require('./menu');
const { displayWidth, truncateToWidth } = require('./creative');
const term = require('./play/term');

const ESC = '\x1b';
const HEADER_ROWS = 3;
const FOOTER_ROWS = 2;
const ITEM_ROWS = 4;
const MIN_COLS = 24; // narrower / shorter than this: a one-line "make it bigger" message
const MIN_ROWS = 6;

/** Items from a demo fixture file ({items:[...]} or a bare array), sanitized like any feed. [] when unreadable. */
function readFixture(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return sanitizeItems(Array.isArray(raw) ? raw : raw && raw.items);
  } catch {
    return [];
  }
}

/**
 * @param {{force?:boolean}} [o] force: bypass the cache TTL and fetch now (only with `fetch`)
 * @returns {Promise<{items:object[], state:'off'|'ready', reason:string|null, demo:boolean, topics:string[]}>}
 *   reason (state 'off' only): 'consent' | 'disabled' | 'topics'
 */
async function loadNews({ dir, fetch = false, force = false, env = process.env, apiUrl } = {}) {
  const state = interests.loadInterests(dir);
  const active = interests.isNewsActive(state);
  const fixture = env.MESHAD_NEWS_FIXTURE;
  if (fixture) {
    const all = readFixture(fixture);
    return { items: active ? filterMatchingItems(all, state.topics) : all, state: 'ready', reason: null, demo: true, topics: state.topics };
  }
  if (!active) {
    const reason = !state.consented_at ? 'consent' : state.topics.length === 0 ? 'topics' : 'disabled';
    return { items: [], state: 'off', reason, demo: false, topics: state.topics };
  }
  const cache = new NewsCache({ dir, apiUrl: apiUrl || config.apiUrl(config.load()) });
  let all = [];
  if (fetch && force) all = (await cache.refresh()) || sanitizeItems((cache.peek() || {}).items);
  else if (fetch) all = await cache.getFeed();
  else {
    const peeked = cache.peek();
    all = peeked && Array.isArray(peeked.items) ? sanitizeItems(peeked.items) : [];
  }
  return { items: filterMatchingItems(all, state.topics), state: 'ready', reason: null, demo: false, topics: state.topics };
}

const clip = (s, width) => (displayWidth(s) <= width ? s : `${truncateToWidth(s, Math.max(0, width - 1))}…`);

/** The tracking-free https URL as shown (scheme kept so terminals make it clickable); "" if unsafe. */
function displayUrl(raw) {
  return cleanOpenUrl(raw) || '';
}

/**
 * One headline as 4 rows (badge · chip · time / title / link / blank), or 1 row when `compact`.
 * `selected` paints a bar down the left edge (`❯` in plain mode); `read` dims it and adds a ✓.
 */
function itemLines(item, { style, cols, now, selected = false, read = false, compact = false }) {
  const width = Math.max(10, cols - 1);
  const p = parts(item, style, now);
  const bar = selected ? (style.on ? style.paint('▌', { fg: 'cyan', bold: true }) : '>') : ' ';
  const mark = read ? style.paint('✓', { fg: 'green' }) : ' ';
  const lead = `${bar}${mark} `; // bar(1) + read mark(1) + space(1)
  const leadW = 3;
  const titleColor = read ? { fg: 'mute' } : { fg: 'ink', bold: true };
  if (compact) {
    const src = width >= 44 ? `[${String(item.source || 'news').toUpperCase()}] ` : ''; // narrow pane: the headline wins
    return [`${lead}${style.paint(clip(`${src}${p.title}`, width - leadW), titleColor)}`];
  }
  const head = read || !style.on
    ? style.paint([`[${String(item.source || 'news').toUpperCase()}]`, `[${shortTopic(item)}]`, p.ago && p.ago.plain].filter(Boolean).join(' '), { fg: 'mute' })
    : [p.badge.styled, p.chip.styled, p.ago && p.ago.styled].filter(Boolean).join(' ');
  return [
    `${lead}${head}`,
    `${bar}  ${style.paint(clip(p.title, width - 3), titleColor)}`,
    `${bar}  ${style.paint(clip(displayUrl(item.url) || item.url, width - 3), { fg: 'cyan', dim: true })}`,
    '',
  ];
}

/**
 * Pure: the screen for `items`. Always `rows` lines (footer last).
 * With `selected` (an index) the list auto-scrolls to keep that item visible; without it `offset` is a plain scroll.
 * @returns {{lines:string[], perPage:number, maxOffset:number, offset:number}}
 */
function renderNews({
  items, cols = 80, rows = 24, style = term.makeStyle('none'), now = Date.now(), offset = 0, selected = null,
  read = new Set(), notice = '', state = 'ready', reason = null, topics = [], demo = false, canRefresh = false,
}) {
  const { t } = i18n;
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    const msg = clip(t('news.small'), Math.max(1, cols - 1));
    return { lines: [msg, ...Array(Math.max(0, rows - 1)).fill('')].slice(0, rows), perPage: 1, maxOffset: 0, offset: 0 };
  }
  const compact = rows - HEADER_ROWS - FOOTER_ROWS < ITEM_ROWS * 2;
  const itemRows = compact ? 1 : ITEM_ROWS;
  const perPage = Math.max(1, Math.floor((rows - HEADER_ROWS - FOOTER_ROWS) / itemRows));
  const maxOffset = Math.max(0, items.length - perPage);
  let at = Math.min(Math.max(0, offset), maxOffset);
  if (selected !== null && items.length) {
    if (selected < at) at = selected;
    else if (selected >= at + perPage) at = selected - perPage + 1;
    at = Math.min(Math.max(0, at), maxOffset);
  }
  const out = [
    `  ${style.gradient(`▍${t('news.title')}`, 'cyan', 'magenta', { bold: true })}${demo ? `  ${style.paint(` ${t('news.demo')} `, { fg: 'night', bg: 'amber', bold: true })}` : ''}`,
    `  ${style.paint(t('news.subtitle', { n: topics.length }), { fg: 'mute' })}`,
    '',
  ];
  const message = (key, color = 'amber') => {
    for (const line of t(key).split('\n')) out.push(`  ${style.paint(clip(line, cols - 4), { fg: color })}`);
  };
  if (state === 'off') message(reason === 'topics' ? 'news.noTopics' : 'news.off');
  else if (items.length === 0) {
    message('news.empty');
    out.push('');
    message(canRefresh ? 'news.empty.refresh' : 'news.empty.offline', 'mute');
  } else {
    items.slice(at, at + perPage).forEach((item, i) => {
      const isSel = selected === at + i;
      out.push(...itemLines(item, { style, cols, now, selected: isSel, read: read.has(newsRead.readKey(item)), compact }));
    });
  }
  while (out.length < rows - FOOTER_ROWS) out.push('');
  out.length = rows - FOOTER_ROWS; // a tall message must never push the footer off the screen
  const range = items.length ? `  ${t('news.range', { a: at + 1, b: Math.min(items.length, at + perPage), n: items.length })}` : '';
  const keys = cols >= 64 ? t('news.keys') + (canRefresh ? t('news.keys.refresh') : '') : t('news.keys.short');
  out.push(notice ? `  ${style.paint(notice, { fg: 'amber', bold: true })}` : '', `  ${style.paint(`${keys}${cols >= 64 ? range : ''}`, { fg: 'mute' })}`);
  return { lines: out.slice(0, rows).map((l) => clip2(l, cols - 1)), perPage, maxOffset, offset: at };
}

// Plain-text width guard only (styled lines are built to fit; this just stops a runaway row from wrapping).
function clip2(line, width) {
  return displayWidth(line.replace(/\x1b\[[0-9;]*m/g, '')) <= width ? line : require('./render').sanitizeAnsiLine(line, width).text;
}

/**
 * Open the view; resolves when the user leaves it. Without a TTY it just prints one page and returns.
 * `openUrl(url) → boolean` is injectable so tests never launch a browser.
 */
async function showNews({
  dir = config.configDir(), fetch = false, stdin = process.stdin, stdout = process.stdout, env = process.env, now = Date.now,
  openUrl = systemOpenUrl,
} = {}) {
  let data = await loadNews({ dir, fetch, env });
  const style = term.autoStyle(env, stdout);
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  const canRefresh = () => fetch && !data.demo && data.state === 'ready';
  if (!stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    const { cols, rows } = size();
    stdout.write(`${renderNews({ ...data, cols, rows, style, now: now() }).lines.join('\n')}\n`);
    return;
  }

  await new Promise((resolve) => {
    let offset = 0;
    let selected = 0;
    let read = new Set(newsRead.loadRead(dir));
    let notice = '';
    let busy = false;
    let last = [];
    let finished = false;
    let release = () => {};
    const draw = () => {
      if (finished) return;
      const { cols, rows } = size();
      selected = Math.min(selected, Math.max(0, data.items.length - 1));
      const view = renderNews({ ...data, cols, rows, style, now: now(), offset, selected: data.items.length ? selected : null, read, notice, canRefresh: canRefresh() });
      offset = view.offset;
      const patch = term.rowsPatch(last, view.lines);
      last = view.lines;
      if (patch) stdout.write(patch);
    };
    const onResize = () => { last = []; stdout.write(`${ESC}[2J`); draw(); };
    const finish = () => {
      if (finished) return;
      finished = true;
      stdin.removeListener('data', onData);
      stdout.removeListener('resize', onResize);
      release();
      restore();
      stdin.pause();
      resolve();
    };
    let restored = false;
    function restore() { // idempotent: also runs on exit, SIGINT/SIGTERM/SIGHUP and an uncaught error
      if (restored) return;
      restored = true;
      try { stdin.setRawMode(false); } catch { /* not a TTY anymore */ }
      stdout.write(`${ESC}[?25h${ESC}[?1049l`);
    }
    const persist = (item, value) => {
      try { read = new Set(newsRead.setRead(dir, newsRead.readKey(item), value)); } catch { /* read-only config dir: marks just don't stick */ }
    };
    const open = (item) => {
      let ok = false;
      try { ok = !!openUrl(cleanOpenUrl(item.url)); } catch { ok = false; }
      notice = ok ? i18n.t('news.opened') : i18n.t('news.openFailed', { url: displayUrl(item.url) });
      if (ok) persist(item, true);
    };
    const reload = async () => {
      if (busy) return;
      busy = true;
      notice = i18n.t('news.refreshing');
      draw();
      try { data = await loadNews({ dir, fetch, force: true, env }); notice = data.items.length ? i18n.t('news.refreshed') : i18n.t('news.offlineNow'); } catch { notice = i18n.t('news.offlineNow'); }
      busy = false;
      draw();
    };
    function onData(chunk) {
      const item = data.items[selected];
      for (const key of parseKeys(chunk)) {
        const ch = key.name === 'char' ? key.ch : '';
        if (key.name === 'escape' || key.name === 'ctrl-c' || /^[qQ]$/.test(ch)) return finish();
        notice = '';
        if (key.name === 'up' || ch === 'k') selected = Math.max(0, selected - 1);
        else if (key.name === 'down' || ch === 'j') selected = Math.min(Math.max(0, data.items.length - 1), selected + 1);
        else if (ch === 'g') selected = 0;
        else if (ch === 'G') selected = Math.max(0, data.items.length - 1);
        else if (key.name === 'enter' && data.items[selected]) open(data.items[selected]);
        else if ((ch === 'm' || ch === 'M' || key.name === 'space') && data.items[selected]) persist(data.items[selected], !read.has(newsRead.readKey(data.items[selected])));
        else if ((ch === 'r' || ch === 'R') && canRefresh()) reload();
        else if (key.name === 'enter' && !item) return finish(); // nothing to open: Enter just leaves
      }
      draw();
    }
    stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    release = term.guardTerminal({ restore, onSignal: finish });
    draw();
  });
}

module.exports = { showNews, renderNews, loadNews, readFixture, itemLines, displayUrl };

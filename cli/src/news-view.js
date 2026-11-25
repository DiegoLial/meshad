'use strict';

/**
 * Full-screen headlines view (menu → Headlines, play picker → Headlines).
 *
 * Local-only: the list is the cached generic feed (news-cache.json) filtered by the
 * topics in interests.json, on this computer. Nothing here sends anything; the
 * only network use is the same anonymous GET /v1/news/feed that `meshad run --news`
 * already does, and only when the caller allows it (`fetch: true`, i.e. the main
 * menu — the play picker stays offline). Links are printed, never opened.
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
const { parseKeys } = require('./menu');
const { displayWidth, truncateToWidth } = require('./creative');
const term = require('./play/term');

const ESC = '\x1b';
const HEADER_ROWS = 3;
const FOOTER_ROWS = 2;
const ITEM_ROWS = 4;

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
 * @returns {Promise<{items:object[], state:'off'|'ready', demo:boolean, topics:string[]}>}
 */
async function loadNews({ dir, fetch = false, env = process.env, apiUrl } = {}) {
  const state = interests.loadInterests(dir);
  const active = interests.isNewsActive(state);
  const fixture = env.MESHAD_NEWS_FIXTURE;
  if (fixture) {
    const all = readFixture(fixture);
    return { items: active ? filterMatchingItems(all, state.topics) : all, state: 'ready', demo: true, topics: state.topics };
  }
  if (!active) return { items: [], state: 'off', demo: false, topics: state.topics };
  const cache = new NewsCache({ dir, apiUrl: apiUrl || config.apiUrl(config.load()) });
  let all = [];
  if (fetch) all = await cache.getFeed();
  else {
    const peeked = cache.peek();
    all = peeked && Array.isArray(peeked.items) ? sanitizeItems(peeked.items) : [];
  }
  return { items: filterMatchingItems(all, state.topics), state: 'ready', demo: false, topics: state.topics };
}

const clip = (s, width) => (displayWidth(s) <= width ? s : `${truncateToWidth(s, Math.max(0, width - 1))}…`);

/** One headline as 4 rows: badge · chip · time / title / link / blank. */
function itemLines(item, { style, cols, now }) {
  const width = Math.max(10, cols - 1);
  const p = parts(item, style, now);
  const head = style.on
    ? [p.badge.styled, p.chip.styled, p.ago && p.ago.styled].filter(Boolean).join(' ')
    : [`[${String(item.source || 'news').toUpperCase()}]`, `[${shortTopic(item)}]`, p.ago && p.ago.plain].filter(Boolean).join(' ');
  return [
    ` ${head}`,
    `  ${style.paint(clip(p.title, width - 2), { fg: 'ink', bold: true })}`,
    `  ${style.paint(clip(item.url, width - 2), { fg: 'cyan', dim: true })}`,
    '',
  ];
}

/**
 * Pure: the screen for `items` scrolled to `offset`. Always `rows` lines (footer last).
 * @returns {{lines:string[], perPage:number, maxOffset:number}}
 */
function renderNews({ items, cols = 80, rows = 24, style = term.makeStyle('none'), now = Date.now(), offset = 0, state = 'ready', topics = [], demo = false }) {
  const { t } = i18n;
  const perPage = Math.max(1, Math.floor((rows - HEADER_ROWS - FOOTER_ROWS) / ITEM_ROWS));
  const maxOffset = Math.max(0, items.length - perPage);
  const at = Math.min(Math.max(0, offset), maxOffset);
  const out = [
    `  ${style.gradient(`▍${t('news.title')}`, 'cyan', 'magenta', { bold: true })}${demo ? `  ${style.paint(` ${t('news.demo')} `, { fg: 'night', bg: 'amber', bold: true })}` : ''}`,
    `  ${style.paint(t('news.subtitle', { n: topics.length }), { fg: 'mute' })}`,
    '',
  ];
  if (state === 'off') out.push(`  ${style.paint(t('news.off'), { fg: 'amber' })}`);
  else if (items.length === 0) out.push(`  ${style.paint(t('news.empty'), { fg: 'amber' })}`);
  else for (const item of items.slice(at, at + perPage)) out.push(...itemLines(item, { style, cols, now }));
  while (out.length < rows - FOOTER_ROWS) out.push('');
  const range = items.length ? `  ${t('news.range', { a: at + 1, b: Math.min(items.length, at + perPage), n: items.length })}` : '';
  out.push('', `  ${style.paint(`${t('news.keys')}${range}`, { fg: 'mute' })}`);
  return { lines: out.slice(0, rows).map((l) => clip2(l, cols - 1)), perPage, maxOffset };
}

// Plain-text width guard only (styled lines are built to fit; this just stops a runaway row from wrapping).
function clip2(line, width) {
  return displayWidth(line.replace(/\x1b\[[0-9;]*m/g, '')) <= width ? line : require('./render').sanitizeAnsiLine(line, width).text;
}

/** Open the view; resolves when the user leaves it. Without a TTY it just prints one page and returns. */
async function showNews({ dir = config.configDir(), fetch = false, stdin = process.stdin, stdout = process.stdout, env = process.env, now = Date.now } = {}) {
  const data = await loadNews({ dir, fetch, env });
  const style = term.autoStyle(env, stdout);
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
  if (!stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    const { cols, rows } = size();
    stdout.write(`${renderNews({ ...data, cols, rows, style, now: now() }).lines.join('\n')}\n`);
    return;
  }

  await new Promise((resolve) => {
    let offset = 0;
    let last = [];
    let finished = false;
    const draw = () => {
      const { cols, rows } = size();
      const view = renderNews({ ...data, cols, rows, style, now: now(), offset });
      offset = Math.min(offset, view.maxOffset);
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
      process.removeListener('exit', restore);
      restore();
      stdin.pause();
      resolve();
    };
    function restore() {
      try { stdin.setRawMode(false); } catch { /* not a TTY anymore */ }
      stdout.write(`${ESC}[?25h${ESC}[?1049l`);
    }
    function onData(chunk) {
      for (const key of parseKeys(chunk)) {
        if (key.name === 'up') offset = Math.max(0, offset - 1);
        else if (key.name === 'down') offset += 1;
        else if (key.name === 'escape' || key.name === 'ctrl-c' || key.name === 'enter' || (key.name === 'char' && /^[qQ]$/.test(key.ch))) return finish();
      }
      draw();
    }
    stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    process.on('exit', restore);
    draw();
  });
}

module.exports = { showNews, renderNews, loadNews, readFixture, itemLines };

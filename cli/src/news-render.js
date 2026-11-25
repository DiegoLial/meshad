'use strict';

/**
 * Format news headlines into ANSI-safe terminal lines. News is NEVER labeled
 * "sponsored" (it isn't, and it is never billed): a line reads
 *
 *   ┃ SOURCE ┃ topic ┃ 12m ago  Title  https://link
 *
 * (source badge · topic chip · relative time · title · link out). With colour
 * off (NO_COLOR, non-TTY, TERM=dumb) it degrades to `[topic] Title — Source · 12m ago (url)`.
 * When shown on its own (no ad row to carry the pause hint) the last line gets a
 * `news · (meshad pause)` suffix that wins over the headline when space is
 * tight — truncation eats the headline, never the hint, and nothing wraps.
 */

const { sanitizeLine } = require('./render');
const { displayWidth, truncateToWidth } = require('./creative');
const { autoStyle } = require('./play/term');
const i18n = require('./i18n');

const MIN_COLS = 40;
const MAX_LINES = 2;
const MAX_BADGE = 16;
const DAY_MS = 86_400_000;

/** Topic → chip colour (palette names from play/term.js). */
const TOPIC_COLOR = {
  'lang:typescript': 'sky', 'lang:python': 'gold', 'lang:rust': 'amber', 'lang:go': 'cyan', 'lang:javascript': 'gold',
  'ai:agents': 'magenta', 'ai:llm': 'violet', 'topic:security': 'red', 'topic:systems': 'mute', 'topic:devtools': 'lime',
  'topic:oss': 'green', 'topic:databases': 'sky', 'topic:web': 'cyan', 'topic:brasil': 'green',
};

function topicOf(item) {
  return String(item.topic || (item.topics && item.topics[0]) || '');
}

function shortTopic(item) {
  return topicOf(item).split(':').pop() || 'news';
}

/** "12m ago" / "há 12 min" for an ISO time up to a week old; null when unknown, older, or unparseable. Never negative. */
function timeAgo(iso, now = Date.now()) {
  const ms = new Date(iso).getTime();
  if (!iso || !Number.isFinite(ms)) return null;
  const age = Math.max(0, now - ms);
  const { t } = i18n;
  if (age < 60_000) return t('news.ago.now');
  if (age < 3_600_000) return t('news.ago.min', { n: Math.floor(age / 60_000) });
  if (age < DAY_MS) return t('news.ago.hour', { n: Math.floor(age / 3_600_000) });
  if (age < 7 * DAY_MS) return t('news.ago.day', { n: Math.floor(age / DAY_MS) });
  return null;
}

const badgeText = (item) => ` ${truncateToWidth(String(item.source || 'news').toUpperCase(), MAX_BADGE)} `;

/** The styled pieces of one headline, each with its plain twin (for width maths). */
function parts(item, style, now) {
  const title = sanitizeLine(item.title, Infinity);
  const ago = timeAgo(item.published_at, now);
  const topic = shortTopic(item);
  return {
    title,
    badge: { plain: badgeText(item), styled: style.paint(badgeText(item), { fg: 'night', bg: 'amber', bold: true }) },
    chip: { plain: ` ${topic} `, styled: style.paint(` ${topic} `, { fg: 'night', bg: TOPIC_COLOR[topicOf(item)] || 'sky', bold: true }) },
    ago: ago ? { plain: ago, styled: style.paint(ago, { fg: 'mute' }) } : null,
    url: { plain: item.url, styled: style.paint(item.url, { fg: 'cyan', dim: true }) },
  };
}

/** `body  suffix`, truncating the body (never the suffix) to fit maxWidth. Null if even the suffix can't fit. */
function fit(body, suffix, maxWidth) {
  if (!suffix) return sanitizeLine(body, maxWidth);
  const sw = displayWidth(suffix);
  if (sw > maxWidth) return null;
  const room = maxWidth - sw - 2;
  if (room <= 0) return suffix;
  const clean = sanitizeLine(body, Infinity);
  if (displayWidth(clean) <= room) return `${clean}  ${suffix}`;
  const cut = truncateToWidth(clean, Math.max(0, room - 1)).replace(/[\s.,;:—-]+$/, '');
  return cut ? `${cut}…  ${suffix}` : suffix;
}

/** Plain fallback line (no colour). */
function plainLine(item, p, maxWidth, hint) {
  const source = item.source ? ` — ${item.source}` : '';
  const when = p.ago ? ` · ${p.ago.plain}` : '';
  const body = `[${shortTopic(item)}] ${item.title}${source}${when} (${item.url})`;
  const compact = `[${shortTopic(item)}] ${item.title} — ${item.url}`;
  const text = displayWidth(body) <= maxWidth - (hint ? displayWidth(hint) + 2 : 0) ? body : compact;
  return fit(text, hint, maxWidth);
}

/**
 * One coloured line: tries badge+chip+time, then drops the time, then the badge, keeping the
 * first layout that leaves a readable slice of the title. The hint (if any) is reserved first.
 */
function styledLine(p, style, maxWidth, hintPlain, hintStyled) {
  const reserve = hintPlain ? displayWidth(hintPlain) + 2 : 0;
  const layouts = [
    [p.badge, p.chip, p.ago],
    [p.badge, p.chip],
    [p.chip],
  ];
  for (const lead of layouts) {
    const items = lead.filter(Boolean);
    const leadW = items.reduce((n, x) => n + displayWidth(x.plain) + 1, 0);
    const room = maxWidth - leadW - reserve - 2; // shared by title + link
    const titleW = displayWidth(p.title);
    const urlW = displayWidth(p.url.plain);
    // Everything fits → show it all. Otherwise the headline is the part people read: it keeps its full
    // width while ≥24 cells are left for the link, and only then is it cut (the link shrinks first).
    const linkMin = Math.min(urlW, 24);
    const shownTitleW = titleW + urlW <= room ? titleW : Math.min(titleW, Math.max(24, room - linkMin));
    const urlRoom = room - shownTitleW;
    if (room < Math.min(titleW, 24) + 18 || urlRoom < Math.min(urlW, 18)) continue;
    const title = shownTitleW >= titleW ? p.title : `${truncateToWidth(p.title, shownTitleW - 1).replace(/[\s.,;:—-]+$/, '')}…`;
    const urlText = urlW <= urlRoom ? p.url.plain : `${truncateToWidth(p.url.plain, urlRoom - 1)}…`;
    const used = leadW + displayWidth(title) + 2 + displayWidth(urlText);
    const gap = hintPlain ? ' '.repeat(Math.max(2, maxWidth - used - displayWidth(hintPlain))) : '';
    return `${items.map((x) => `${x.styled} `).join('')}${style.paint(title, { fg: 'ink', bold: true })}  ${style.paint(urlText, { fg: 'cyan', dim: true })}${hintPlain ? `${gap}${hintStyled}` : ''}`;
  }
  return null;
}

/**
 * @param {Array} items  already-sanitized feed items
 * @param {number} cols  terminal width
 * @param {{standalone?: boolean, hint?: string, style?: object, now?: number}} [opts]
 * @returns {string[]} ANSI lines, or [] (fail-closed) on a narrow terminal / no items
 */
function formatNews(items, cols = 80, opts = {}) {
  if (!Array.isArray(items) || items.length === 0 || !(cols >= MIN_COLS)) return [];
  const style = opts.style || autoStyle();
  const now = opts.now ?? Date.now();
  const maxWidth = cols - 1;
  const picked = items.slice(0, MAX_LINES);
  const hint = opts.standalone ? (opts.hint || 'news · (meshad pause)') : '';
  const lines = [];

  picked.forEach((item, i) => {
    const lineHint = i === picked.length - 1 ? hint : '';
    const p = parts(item, style, now);
    const line = style.on
      ? styledLine(p, style, maxWidth, lineHint, style.paint(lineHint, { fg: 'mute' })) ?? fitStyled(plainLine(item, p, maxWidth, lineHint), style)
      : plainLine(item, p, maxWidth, lineHint);
    if (line !== null) lines.push(line);
  });
  return lines;
}

/** Last resort in colour mode when even the compact layout can't fit: the plain line in cyan. */
function fitStyled(plain, style) {
  return plain === null ? null : style.paint(plain, { fg: 'cyan' });
}

module.exports = { formatNews, timeAgo, parts, topicOf, shortTopic, TOPIC_COLOR, MIN_COLS, MAX_LINES };

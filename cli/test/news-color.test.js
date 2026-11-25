'use strict';

/** News restyle: source badge, topic chip, relative time, never "sponsored", plain at NO_COLOR; the full-screen view and the demo fixture. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { formatNews, timeAgo } = require('../src/news-render');
const { sanitizeItem } = require('../src/news');
const { renderNews, loadNews, readFixture } = require('../src/news-view');
const interests = require('../src/interests');
const term = require('../src/play/term');
const i18n = require('../src/i18n');
const { displayWidth } = require('../src/creative');

const FIXTURE = path.join(__dirname, 'fixtures', 'news-demo-metropoles.json');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const flat = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/ +/g, ' ');
const NOW = Date.parse('2026-11-25T00:31:44Z');

const item = (over = {}) => sanitizeItem({
  title: 'CNI aciona o STF contra portaria do governo', url: 'https://example.com/brasil/cni', source: 'Metrópoles',
  topics: ['topic:brasil'], published_at: '2026-11-25T00:19:44Z', ...over,
});

test('sanitizeItem: optional published_at is kept as ISO, junk and absence become null', () => {
  assert.equal(item().published_at, '2026-11-25T00:19:44.000Z');
  assert.equal(item({ published_at: undefined }).published_at, null);
  assert.equal(item({ published_at: 'yesterday-ish' }).published_at, null);
  assert.equal(item({ published_at: { x: 1 } }).published_at, null);
  assert.equal(item({ published_at: 1000 }).published_at, null, 'pre-2000 epoch is not a publish time');
  assert.equal(item({ published_at: Date.UTC(2026, 10, 24) }).published_at, '2026-11-24T00:00:00.000Z');
  assert.ok(sanitizeItem({ title: 'x', url: 'https://a.dev/x', topics: ['topic:brasil'] }), 'topic:brasil is in the closed taxonomy');
});

test('taxonomy: topic:brasil is in the CLI and the API lists, which stay identical', { skip: fs.existsSync(path.join(__dirname, '..', '..', 'api', 'src', 'news.js')) ? false : 'apps/api is not in the public mirror' }, () => {
  const api = require('../../api/src/news');
  assert.ok(interests.TAXONOMY.includes('topic:brasil'));
  assert.deepEqual([...api.INTEREST_TAXONOMY], [...interests.TAXONOMY]);
});

test('timeAgo: now / minutes / hours / days in en and pt-BR; never negative; null when unknown or old', () => {
  const at = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(timeAgo(at(10_000), NOW), 'just now');
  assert.equal(timeAgo(at(12 * 60_000), NOW), '12m ago');
  assert.equal(timeAgo(at(3 * 3_600_000), NOW), '3h ago');
  assert.equal(timeAgo(at(2 * 86_400_000), NOW), '2d ago');
  assert.equal(timeAgo(at(9 * 86_400_000), NOW), null);
  assert.equal(timeAgo(new Date(NOW + 5 * 60_000).toISOString(), NOW), 'just now', 'clock skew never shows a negative age');
  assert.equal(timeAgo(null, NOW), null);
  assert.equal(timeAgo('garbage', NOW), null);
  i18n.init({ lang: 'pt-BR' });
  try {
    assert.equal(timeAgo(at(12 * 60_000), NOW), 'há 12 min');
    assert.equal(timeAgo(at(3 * 3_600_000), NOW), 'há 3 h');
    assert.equal(timeAgo(at(10_000), NOW), 'agora');
  } finally { i18n.init({ lang: 'en' }); }
});

test('formatNews (colour): black-on-amber source badge, topic chip, time, title, link — fits, never "sponsored"', () => {
  const items = [item(), item({ title: 'Headline two '.repeat(8), url: 'https://example.org/b', published_at: '2026-11-24T22:00:00Z' })];
  const style = term.makeStyle('truecolor');
  for (const cols of [60, 80, 120, 200]) {
    for (const standalone of [false, true]) {
      const lines = formatNews(items, cols, { style, now: NOW, standalone });
      assert.ok(lines.length >= 1 && lines.length <= 2);
      for (const l of lines) {
        assert.ok(displayWidth(l.replace(/\x1b\[[0-9;]*m/g, '')) <= cols - 1, `fits ${cols}`);
        assert.doesNotMatch(flat(l), /sponsored/i);
      }
    }
  }
  const [first] = formatNews(items, 140, { style, now: NOW });
  assert.match(first, /\x1b\[1;38;2;11;16;32;48;2;255;176;0m METRÓPOLES \x1b\[0m/, 'black text on amber');
  assert.match(first, /48;2;61;220;132m brasil /, 'topic chip');
  assert.match(flat(first), /METRÓPOLES brasil 12m ago CNI aciona o STF contra portaria do governo https:\/\/example\.com\/brasil\/cni/);
  assert.match(flat(formatNews(items, 140, { style, now: NOW, standalone: true }).at(-1)), /news · \(meshad pause\)$/);
  assert.doesNotMatch(flat(formatNews([item({ published_at: null })], 140, { style, now: NOW })[0]), /ago|há/, 'no time → no time chip');
  assert.deepEqual(formatNews(items, 39, { style }), [], 'narrow → nothing');
});

test('formatNews (NO_COLOR / plain): no escapes, still labelled, time kept, never "sponsored"', () => {
  const plain = formatNews([item()], 120, { style: term.makeStyle('none'), now: NOW });
  assert.equal(plain.length, 1);
  assert.ok(!plain[0].includes('\x1b'));
  assert.equal(plain[0], '[brasil] CNI aciona o STF contra portaria do governo — Metrópoles · 12m ago (https://example.com/brasil/cni)');
  assert.doesNotMatch(plain[0], /sponsored/i);
});

test('news view: coloured list with badge/chip/time/title/link rows; empty and off states; plain fallback', () => {
  const items = readFixture(FIXTURE);
  assert.equal(items.length, 9);
  const style = term.makeStyle('truecolor');
  const view = renderNews({ items, cols: 100, rows: 24, style, now: NOW, topics: ['topic:brasil'], demo: true });
  assert.equal(view.lines.length, 24);
  const text = flat(view.lines.join('\n'));
  assert.match(text, /MeshAd News/);
  assert.match(text, /demo fixture/);
  assert.match(text, /METRÓPOLES brasil 12m ago/);
  assert.match(text, /Mbappé presenteia Vini Jr\./);
  assert.match(text, /https:\/\/www\.metropoles\.com\/esportes\/mbappe/);
  assert.match(text, /↑\/↓ scroll · Esc back 1-4 of 9/);
  assert.doesNotMatch(text, /sponsored/i);
  for (const l of view.lines) assert.ok(displayWidth(l.replace(/\x1b\[[0-9;]*m/g, '')) <= 99);
  const scrolled = flat(renderNews({ items, cols: 100, rows: 24, style, now: NOW, offset: 99 }).lines.join('\n'));
  assert.match(scrolled, /6-9 of 9/, 'offset is clamped to the last page');

  const plain = renderNews({ items, cols: 100, rows: 24, style: term.makeStyle('none'), now: NOW }).lines.join('\n');
  assert.ok(!plain.includes('\x1b'));
  assert.match(plain, /\[METRÓPOLES\] \[brasil\] 12m ago/);

  assert.match(renderNews({ items: [], style: term.makeStyle('none') }).lines.join('\n'), /No headlines yet/);
  assert.match(renderNews({ items: [], state: 'off', style: term.makeStyle('none') }).lines.join('\n'), /News is off/);
});

test('demo fixture: nine real Metrópoles headlines inside the taxonomy, every one with a publish time, nothing tracked', () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(raw.items.length, 9);
  for (const it of raw.items) {
    assert.equal(it.source, 'Metrópoles');
    assert.ok(it.topics.every((t) => interests.TAXONOMY.includes(t)));
    assert.ok(Number.isFinite(Date.parse(it.published_at)));
    assert.match(it.url, /^https:\/\/www\.metropoles\.com\//);
  }
  assert.equal(readFixture(FIXTURE).length, 9, 'all survive sanitizeItem');
  assert.deepEqual(readFixture('/nonexistent/file.json'), []);
});

test('MESHAD_NEWS_FIXTURE: only when set does the view read the file; production paths never mention it or Metrópoles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-nv-'));
  const off = await loadNews({ dir, env: {} });
  assert.equal(off.state, 'off');
  assert.deepEqual(off.items, []);
  assert.equal(off.demo, false);

  const demo = await loadNews({ dir, env: { MESHAD_NEWS_FIXTURE: FIXTURE } });
  assert.equal(demo.demo, true);
  assert.equal(demo.items.length, 9, 'with news off the demo shows the whole fixture');

  // with topics selected the usual local filter still applies to the fixture
  interests.saveInterests(dir, { enabled: true, consented_at: '2026-11-24T00:00:00Z', topics: ['lang:rust'] });
  assert.equal((await loadNews({ dir, env: { MESHAD_NEWS_FIXTURE: FIXTURE } })).items.length, 0);
  interests.saveInterests(dir, { enabled: true, consented_at: '2026-11-24T00:00:00Z', topics: ['topic:brasil'] });
  assert.equal((await loadNews({ dir, env: { MESHAD_NEWS_FIXTURE: FIXTURE } })).items.length, 9);

  // without the env var the cache is the only source (offline: cache only, no fetch)
  fs.writeFileSync(path.join(dir, 'news-cache.json'), JSON.stringify({ fetched_at: 1, ttl_seconds: 1, items: [{ title: 'Cached', url: 'https://x.dev/c', topics: ['topic:brasil'] }] }));
  const cached = await loadNews({ dir, env: {} });
  assert.deepEqual(cached.items.map((i) => i.title), ['Cached']);

  const src = path.join(__dirname, '..', 'src');
  for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.js')).concat(fs.readdirSync(path.join(src, 'commands')).map((n) => `commands/${n}`))) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    assert.doesNotMatch(text, /metr[oó]poles/i, `${f} must not hardcode the demo publisher`);
    if (f !== 'news-view.js') assert.doesNotMatch(text, /MESHAD_NEWS_FIXTURE/, `${f}: the fixture is read by the news view only`);
  }
});

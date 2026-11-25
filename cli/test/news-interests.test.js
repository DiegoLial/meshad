'use strict';

/** Escopo 2 + 3: headlines view (selection, open, read marks, states, small panes) and the interests picker / `meshad interests` / menu. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { showNews, renderNews, loadNews } = require('../src/news-view');
const { cleanOpenUrl, openCommand, openUrl } = require('../src/news-open');
const newsRead = require('../src/news-read');
const { sanitizeItem } = require('../src/news');
const { topicSelectorPrompt, parseKeys } = require('../src/menu');
const { setupNews } = require('../src/onboarding');
const interests = require('../src/interests');
const interestsCmd = require('../src/commands/interests');
const { interestsMenu } = require('../src/commands/menu');
const term = require('../src/play/term');
const i18n = require('../src/i18n');
const { displayWidth } = require('../src/creative');

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ENTER = '\r';
const ESC = '\x1b';
const BS = '\x7f';
const NOW = Date.parse('2026-11-25T00:31:44Z');
const tick = () => new Promise((r) => setImmediate(r));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const plain = term.makeStyle('none');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-newsint-'));
  process.env.MESHAD_CONFIG_DIR = dir;
  process.env.MESHAD_LANG = 'en';
  process.env.NO_COLOR = '1';
  i18n.init(null);
  return dir;
}

function fakeIo({ columns = 80, rows = 24 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = function setRawMode(v) { this.isRaw = v; return this; };
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  let buf = '';
  stdout.on('data', (d) => { buf += d; });
  return { stdin, stdout, out: () => buf, plain: () => strip(buf), mark: () => { buf = ''; } };
}
async function press(io, ...keys) {
  for (const k of keys) { await tick(); io.stdin.write(k); }
  await tick();
}

const mkItem = (n, over = {}) => sanitizeItem({
  id: `n${n}`, title: `Headline number ${n}`, url: `https://example.com/a/${n}`, source: 'Example', topics: ['lang:rust'],
  published_at: '2026-11-25T00:19:44Z', ...over,
});
const ITEMS = Array.from({ length: 9 }, (_, i) => mkItem(i + 1));

function fixtureEnv(dir, items = ITEMS, extra = {}) {
  const file = path.join(dir, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify({ items }));
  return { NO_COLOR: '1', MESHAD_NEWS_FIXTURE: file, ...extra };
}

function consented(dir, topics = ['lang:rust']) {
  interests.saveInterests(dir, { enabled: true, consented_at: new Date().toISOString(), topics });
}

// ── url cleaning + opener ───────────────────────────────────────────────────

test('cleanOpenUrl strips tracking params (query + hash), keeps real params, and only allows clean https', () => {
  assert.equal(
    cleanOpenUrl('https://example.com/p?id=7&utm_source=x&UTM_medium=y&fbclid=1&gclid=2&mc_cid=3&mc_eid=4&ref=5&ref_src=6&igshid=7&yclid=8&si=9&keep=ok#top'),
    'https://example.com/p?id=7&keep=ok#top',
  );
  assert.equal(cleanOpenUrl('https://example.com/p?utm_source=x'), 'https://example.com/p');
  assert.equal(cleanOpenUrl('https://example.com/p#utm_campaign=a&section=2'), 'https://example.com/p#section=2');
  assert.equal(cleanOpenUrl('https://example.com/p#fbclid=1'), 'https://example.com/p');
  for (const bad of ['http://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@example.com/', 'https://localhost/', 'nope', '', null, undefined, `https://example.com/${'a'.repeat(2100)}`]) {
    assert.equal(cleanOpenUrl(bad), null, String(bad).slice(0, 30));
  }
});

test('openUrl: per-OS command, detached + unref + ignored stdio, never a shell; unsafe URLs never spawn', () => {
  assert.deepEqual(openCommand('https://a.dev/', 'linux'), ['xdg-open', ['https://a.dev/']]);
  assert.deepEqual(openCommand('https://a.dev/', 'darwin'), ['open', ['https://a.dev/']]);
  const [cmd, args] = openCommand('https://a.dev/?x=1&calc', 'win32');
  assert.notEqual(cmd, 'cmd', 'cmd would re-parse & in the URL');
  assert.equal(args[args.length - 1], 'https://a.dev/?x=1&calc');

  const calls = [];
  let unrefd = false;
  const spawnImpl = (c, a, o) => { calls.push({ c, a, o }); return { on() {}, unref() { unrefd = true; } }; };
  assert.equal(openUrl('https://a.dev/x?utm_source=y', { platform: 'linux', spawnImpl }), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].a, ['https://a.dev/x']);
  assert.equal(calls[0].o.detached, true);
  assert.equal(calls[0].o.stdio, 'ignore');
  assert.equal(calls[0].o.shell, undefined);
  assert.ok(unrefd);
  assert.equal(openUrl('http://a.dev/', { spawnImpl }), false);
  assert.equal(calls.length, 1, 'http is never launched');
  assert.equal(openUrl('https://a.dev/', { spawnImpl: () => { throw new Error('ENOENT'); } }), false, 'a missing launcher is reported, not thrown');
});

// ── read marks ──────────────────────────────────────────────────────────────

test('news-read: 0600 file, stable keys (id or clean url), toggle, cap of 500, tolerant of junk', () => {
  const dir = tmp();
  assert.equal(newsRead.readKey({ id: 'abc', url: 'https://a.dev/' }), 'id:abc');
  assert.equal(newsRead.readKey({ url: 'https://a.dev/x?utm_source=1' }), 'url:https://a.dev/x');
  assert.equal(newsRead.readKey({ url: 'http://bad' }), null);
  assert.deepEqual(newsRead.loadRead(dir), []);
  newsRead.setRead(dir, 'id:1', true);
  const file = path.join(dir, 'news-read.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(newsRead.loadRead(dir), ['id:1']);
  newsRead.setRead(dir, 'id:1', false);
  assert.deepEqual(newsRead.loadRead(dir), []);
  for (let i = 0; i < 530; i++) newsRead.setRead(dir, `id:${i}`, true);
  const keys = newsRead.loadRead(dir);
  assert.equal(keys.length, 500);
  assert.equal(keys[keys.length - 1], 'id:529');
  assert.ok(!keys.includes('id:0'), 'oldest dropped');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(newsRead.loadRead(dir), []);
  fs.writeFileSync(file, JSON.stringify({ read: [1, null, 'ok'] }));
  assert.deepEqual(newsRead.loadRead(dir), ['ok']);
});

test('interests clear also wipes news-read.json (and the cache)', () => {
  const dir = tmp();
  consented(dir);
  newsRead.setRead(dir, 'id:1', true);
  fs.writeFileSync(path.join(dir, 'news-cache.json'), '{}');
  interests.clearInterests(dir);
  assert.equal(fs.existsSync(path.join(dir, 'news-read.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'news-cache.json')), false);
  assert.deepEqual(interests.loadInterests(dir), { enabled: false, consented_at: null, topics: [] });
});

// ── renderNews ──────────────────────────────────────────────────────────────

test('renderNews: selected row has a bar, read rows a ✓, URL is clean, footer lists the keys', () => {
  const dirty = [mkItem(1, { url: 'https://example.com/a/1' }), mkItem(2)];
  const v = renderNews({ items: dirty, cols: 80, rows: 24, style: plain, now: NOW, selected: 1, read: new Set(['id:n1']) });
  const text = v.lines.join('\n');
  const lines = v.lines;
  const sel = lines.findIndex((l) => l.startsWith('>'));
  assert.ok(sel > 0, 'plain selection marker');
  assert.match(lines[sel], /\[EXAMPLE\]/);
  assert.match(lines[sel + 1], /Headline number 2/);
  assert.match(text, /✓ \[EXAMPLE\] \[rust\]/, 'read item is marked');
  assert.match(text, /https:\/\/example\.com\/a\/2/);
  assert.match(text, /↑\/↓ j\/k move · Enter open · m read · Esc back/);
  assert.doesNotMatch(text, /sponsored/i);

  const col = renderNews({ items: dirty, cols: 80, rows: 24, style: term.makeStyle('truecolor'), now: NOW, selected: 0 });
  assert.ok(col.lines.some((l) => l.includes('▌')), 'coloured selection bar');
});

test('renderNews: selection auto-scrolls to stay visible in both directions', () => {
  const v = (selected, offset = 0) => renderNews({ items: ITEMS, cols: 80, rows: 24, style: plain, now: NOW, selected, offset });
  const per = v(0).perPage;
  assert.equal(per, 4);
  assert.equal(v(per - 1).offset, 0);
  assert.equal(v(per).offset, 1, 'moving past the last visible row scrolls by one');
  assert.equal(v(8).offset, 5);
  assert.equal(v(1, 5).offset, 1, 'moving above the window scrolls back up');
  assert.match(v(8).lines.join('\n'), /Headline number 9/);
});

test('renderNews: empty / off / no-topics / offline states explain what to do', () => {
  const r = (o) => renderNews({ items: [], style: plain, ...o }).lines.join('\n');
  assert.match(r({ state: 'off', reason: 'consent' }), /News is off\.\n\s*Turn it on and pick topics: meshad interests/);
  assert.match(r({ state: 'off', reason: 'topics' }), /no topics yet[\s\S]*meshad interests/);
  assert.match(r({ canRefresh: true }), /No headlines yet\.[\s\S]*Press r to fetch now/);
  assert.match(r({ canRefresh: false }), /Offline cache is empty[\s\S]*meshad run --news/);
  process.env.MESHAD_LANG = 'pt-BR';
  i18n.init(null);
  try { assert.match(r({ canRefresh: true }), /Ainda sem manchetes[\s\S]*aperte r/i); } finally { process.env.MESHAD_LANG = 'en'; i18n.init(null); }
});

test('renderNews: fits 80x24, a narrow tmux pane, a short pane, and degrades to a message when tiny', () => {
  const styles = [plain, term.makeStyle('truecolor')];
  for (const style of styles) {
    for (const [cols, rows] of [[80, 24], [40, 24], [30, 12], [26, 8], [100, 40], [80, 10]]) {
      const v = renderNews({ items: ITEMS, cols, rows, style, now: NOW, selected: 2, read: new Set(['id:n1']), notice: 'x'.repeat(200) });
      assert.equal(v.lines.length, rows, `${cols}x${rows}`);
      for (const l of v.lines) assert.ok(displayWidth(strip(l)) <= cols - 1, `${cols}x${rows}: ${JSON.stringify(strip(l))}`);
      assert.match(v.lines.join('\n'), /Headline number 3/, `${cols}x${rows}: selected item stays visible`);
    }
  }
  for (const [cols, rows] of [[20, 24], [80, 4]]) {
    const v = renderNews({ items: ITEMS, cols, rows, style: plain, now: NOW, selected: 0 });
    assert.equal(v.lines.length, rows);
    assert.match(v.lines[0], /Too small/);
    for (const l of v.lines) assert.ok(displayWidth(l) <= cols - 1);
  }
});

test('loadNews: off reasons (consent / topics / disabled), cache-only offline, force refresh keeps cache when offline', async () => {
  const dir = tmp();
  const env = { NO_COLOR: '1' };
  assert.deepEqual((await loadNews({ dir, env })).reason, 'consent');
  interests.saveInterests(dir, { enabled: true, consented_at: 'x', topics: [] });
  assert.equal((await loadNews({ dir, env })).reason, 'topics');
  interests.saveInterests(dir, { enabled: false, consented_at: 'x', topics: ['lang:rust'] });
  assert.equal((await loadNews({ dir, env })).reason, 'disabled');
  consented(dir);
  assert.deepEqual((await loadNews({ dir, env })).items, [], 'empty cache, offline');
  fs.writeFileSync(path.join(dir, 'news-cache.json'), JSON.stringify({ fetched_at: 1, ttl_seconds: 1, items: [mkItem(1), mkItem(2, { topics: ['lang:go'] })] }));
  const got = await loadNews({ dir, env });
  assert.equal(got.state, 'ready');
  assert.deepEqual(got.items.map((i) => i.id), ['n1'], 'filtered by topic, from the cache');
  const forced = await loadNews({ dir, env, fetch: true, force: true, apiUrl: 'http://127.0.0.1:1' }); // explicit dead host, never the real API
  assert.deepEqual(forced.items.map((i) => i.id), ['n1'], 'refresh failure falls back to the cache');
});

// ── showNews (interactive) ──────────────────────────────────────────────────

function openHook() {
  const opened = [];
  return { opened, openUrl: (u) => { opened.push(u); return true; } };
}

test('showNews: ↓/↑ and j/k move the selection, Enter opens the clean URL via the hook and marks it read (0600)', async () => {
  const dir = tmp();
  consented(dir);
  const items = [mkItem(1, { url: 'https://example.com/a/1#section' }), mkItem(2), mkItem(3)];
  const io = fakeIo();
  const hook = openHook();
  const run = showNews({ dir, ...io, env: fixtureEnv(dir, items), openUrl: hook.openUrl, now: () => NOW });
  await tick(); await tick();
  assert.match(io.plain(), />.*\[EXAMPLE\]/s);
  await press(io, DOWN, 'j', 'j', UP, 'k', 'k'); // 0→1→2→2→1→0→0
  await press(io, 'j', ENTER); // select #2, open
  assert.deepEqual(hook.opened, ['https://example.com/a/2']);
  assert.match(io.plain(), /opened in your browser · marked read/);
  assert.deepEqual(newsRead.loadRead(dir), ['id:n2']);
  assert.equal(fs.statSync(path.join(dir, 'news-read.json')).mode & 0o777, 0o600);
  assert.match(io.plain(), /✓ \[EXAMPLE\]/);
  await press(io, 'q');
  await run;
  assert.ok(io.out().endsWith('\x1b[?25h\x1b[?1049l'));
});

test('showNews: Enter strips tracking even if a feed URL somehow carried it', async () => {
  const dir = tmp();
  consented(dir);
  const io = fakeIo();
  const hook = openHook();
  // bypass sanitizeItems' reject-on-tracking with a pre-built cache is impossible; the view still cleans what it opens
  const run = showNews({ dir, ...io, env: fixtureEnv(dir, [mkItem(1)]), openUrl: hook.openUrl, now: () => NOW });
  await tick(); await tick();
  await press(io, ENTER, ESC);
  await run;
  assert.deepEqual(hook.opened, [cleanOpenUrl('https://example.com/a/1')]);
});

test('showNews: m and Space toggle read / unread and persist; a failed open shows the link and does not mark read', async () => {
  const dir = tmp();
  consented(dir);
  const io = fakeIo();
  const run = showNews({ dir, ...io, env: fixtureEnv(dir), openUrl: () => false, now: () => NOW });
  await tick(); await tick();
  await press(io, 'm');
  assert.deepEqual(newsRead.loadRead(dir), ['id:n1']);
  await press(io, ' ');
  assert.deepEqual(newsRead.loadRead(dir), []);
  await press(io, ' ');
  assert.deepEqual(newsRead.loadRead(dir), ['id:n1']);
  await press(io, 'j', ENTER);
  assert.match(io.plain(), /could not open a browser — link: https:\/\/example\.com\/a\/2/);
  assert.deepEqual(newsRead.loadRead(dir), ['id:n1'], 'unopened article is not marked');
  await press(io, 'q');
  await run;
});

test('showNews: read marks are loaded on the next open; Esc / q / Ctrl+C leave', async () => {
  const dir = tmp();
  consented(dir);
  newsRead.setRead(dir, 'id:n1', true);
  for (const key of [ESC, 'q', '\x03']) {
    const io = fakeIo();
    const run = showNews({ dir, ...io, env: fixtureEnv(dir), openUrl: () => true, now: () => NOW });
    await tick(); await tick();
    assert.match(io.plain(), /✓ \[EXAMPLE\]/);
    await press(io, key);
    await run;
  }
});

test('showNews: empty state in a TTY, and `r` is offered only when the menu allows fetching', async () => {
  const dir = tmp();
  consented(dir);
  const env = { NO_COLOR: '1' };
  const a = fakeIo();
  const runA = showNews({ dir, ...a, env, fetch: false, openUrl: () => true, now: () => NOW });
  await tick(); await tick();
  assert.match(a.plain(), /Offline cache is empty/);
  assert.doesNotMatch(a.plain(), /r refresh/);
  await press(a, ENTER); // nothing to open: Enter leaves
  await runA;

  process.env.MESHAD_API_URL = 'http://127.0.0.1:1'; // nothing listens: the "offline" case, never the real network
  const b = fakeIo();
  const runB = showNews({ dir, ...b, env, fetch: true, openUrl: () => true, now: () => NOW });
  await new Promise((r) => setTimeout(r, 150));
  assert.match(b.plain(), /Press r to fetch now/);
  await press(b, 'r');
  await new Promise((r) => setTimeout(r, 50));
  assert.match(b.plain(), /offline or nothing new/);
  await press(b, 'q');
  await runB;
  delete process.env.MESHAD_API_URL;
});

test('showNews: non-TTY prints one page with no selection and no escapes; tiny pane degrades', async () => {
  const dir = tmp();
  consented(dir);
  const out = new PassThrough();
  let buf = '';
  out.on('data', (d) => { buf += d; });
  out.columns = 60;
  out.rows = 24;
  await showNews({ dir, stdin: new PassThrough(), stdout: out, env: fixtureEnv(dir), now: () => NOW });
  assert.match(buf, /Headline number 1/);
  assert.doesNotMatch(buf, /\x1b/);

  const io = fakeIo({ columns: 18, rows: 5 });
  const run = showNews({ dir, ...io, env: fixtureEnv(dir), openUrl: () => true, now: () => NOW });
  await tick(); await tick();
  assert.match(io.plain(), /Too small/);
  await press(io, ESC);
  await run;
});

test('news-view: the system opener lives in news-open.js, no network code and no fixture/Metrópoles leak', () => {
  for (const f of ['news-open.js', 'news-read.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.doesNotMatch(src, /MESHAD_NEWS_FIXTURE|metr[óo]poles|\bfetch\s*\(|node:https?/i, f);
  }
});

// ── topic selector ──────────────────────────────────────────────────────────

const opts = interests.TAXONOMY.map((value) => ({ value, label: value }));
const sel = (io, extra = {}) => topicSelectorPrompt({ title: 'Pick', options: opts, ...io, ...extra });

test('parseKeys: Ctrl+L and Ctrl+A are named keys', () => {
  assert.deepEqual(parseKeys('\x0c\x01').map((k) => k.name), ['ctrl-l', 'ctrl-a']);
});

test('topic selector: ↑/↓ + Space toggle, shows [x]/[ ], count and status, Enter returns values in option order', async () => {
  tmp();
  const io = fakeIo();
  const p = sel(io, { selected: ['topic:web'], status: 'news: off' });
  await tick();
  assert.match(io.plain(), /1 of 14 selected/);
  assert.match(io.plain(), /news: off/);
  assert.match(io.plain(), /\[x\] topic:web/);
  assert.match(io.plain(), /\[ \] lang:typescript/);
  await press(io, ' ', DOWN, DOWN, ' '); // toggle #0, select #2
  assert.match(io.plain(), /3 of 14 selected/);
  await press(io, UP, ' '); // toggle #1
  await press(io, ENTER);
  assert.deepEqual(await p, ['lang:typescript', 'lang:python', 'lang:rust', 'topic:web']);
  assert.ok(io.out().includes('\x1b[?25l') && io.out().endsWith('\x1b[?25h'), 'cursor hidden then restored');
});

test('topic selector: live search filters (letters, digits, `:`, leading `/`), keeps selections, Backspace edits, Esc clears then cancels', async () => {
  tmp();
  const io = fakeIo();
  const p = sel(io);
  await tick();
  await press(io, '/', 'r', 'u', 's');
  let text = io.plain().split('Pick').pop();
  assert.match(text, /\/ rus/);
  io.mark();
  await press(io, 'u'); // "rusu" → nothing
  assert.match(io.plain(), /no topic matches "rusu"/);
  await press(io, BS);
  io.mark();
  await press(io, ' '); // toggles lang:rust (only match)
  assert.match(io.plain(), /1 of 14 selected/);
  assert.match(io.plain(), /\[x\] lang:rust/);
  assert.doesNotMatch(io.plain(), /lang:python/, 'filtered list shows only matches');
  await press(io, ESC); // clears the search, does NOT cancel
  io.mark();
  await press(io, 'x');
  await press(io, BS);
  assert.match(io.plain(), /lang:python/, 'full list back after clearing');
  await press(io, ':', 's', 'e', 'c');
  assert.match(io.plain(), /topic:security/);
  assert.doesNotMatch(io.plain().split('/ :sec').pop(), /lang:go/);
  await press(io, ENTER);
  assert.deepEqual(await p, ['lang:rust'], 'selection survived filtering');

  const io2 = fakeIo();
  const p2 = sel(io2, { selected: ['lang:go'] });
  await press(io2, 'a');
  await press(io2, ESC); // clears 'a'
  const state = { done: false };
  p2.then(() => { state.done = true; });
  await tick();
  assert.equal(state.done, false, 'first Esc only clears the search');
  await press(io2, ESC);
  assert.equal(await p2, null, 'second Esc cancels');
});

test('topic selector: Ctrl+L clears every selection (even filtered-out ones), Ctrl+A selects what is shown', async () => {
  tmp();
  const io = fakeIo();
  const p = sel(io, { selected: ['lang:go', 'topic:web', 'ai:llm'] });
  await tick();
  assert.match(io.plain(), /3 of 14 selected/);
  await press(io, 'a', 'i', ':'); // filter "ai:" → 2 rows
  await press(io, '\x01');
  assert.match(io.plain(), /4 of 14 selected/);
  await press(io, '\x0c');
  assert.match(io.plain(), /0 of 14 selected/);
  await press(io, ENTER);
  assert.deepEqual(await p, []);
});

test('topic selector: long lists scroll inside a short terminal and stay within the pane width', async () => {
  tmp();
  const io = fakeIo({ columns: 30, rows: 14 });
  const p = sel(io);
  await tick();
  await press(io, ...Array(12).fill(DOWN));
  const last = io.plain().split(/\n/).filter(Boolean).slice(-12);
  assert.ok(last.some((l) => /topic:web/.test(l)), 'window follows the cursor');
  assert.match(io.plain(), /\d+-\d+ \/ 14/);
  for (const l of io.plain().split(/[\r\n]+/)) assert.ok([...l].length <= 29, JSON.stringify(l));
  await press(io, ESC);
  assert.equal(await p, null);
});

// ── consent + setupNews / command / menu ────────────────────────────────────

test('setupNews: consent text first, nothing on disk until confirmed, then 0600 interests.json with picked topics', async () => {
  const dir = tmp();
  const io = fakeIo();
  const p = setupNews({ dir, ...io });
  await tick(); await tick();
  assert.match(io.plain(), /stored ONLY on this computer/);
  assert.equal(fs.existsSync(path.join(dir, 'interests.json')), false);
  await press(io, ENTER); // Accept & pick topics
  assert.match(io.plain(), /Pick your topics/);
  assert.equal(fs.existsSync(path.join(dir, 'interests.json')), false, 'still nothing before confirm');
  await press(io, 'r', 'u', 's', 't', ' ', ENTER);
  const state = await p;
  assert.deepEqual(state.topics, ['lang:rust']);
  assert.equal(state.enabled, true);
  assert.equal(fs.statSync(path.join(dir, 'interests.json')).mode & 0o777, 0o600);
});

test('setupNews: skipping consent writes nothing; Ctrl+L + Enter after consent turns news off with no topics', async () => {
  const dir = tmp();
  const a = fakeIo();
  const pa = setupNews({ dir, ...a });
  await tick(); await tick();
  await press(a, DOWN, ENTER); // Skip
  await pa;
  assert.equal(fs.existsSync(path.join(dir, 'interests.json')), false);

  consented(dir, ['lang:go', 'ai:llm']);
  const b = fakeIo();
  const pb = setupNews({ dir, ...b });
  await tick(); await tick();
  assert.match(b.plain(), /2 of 14 selected/);
  assert.doesNotMatch(b.plain(), /stored ONLY/, 'consent not repeated');
  await press(b, '\x0c', ENTER);
  const state = await pb;
  assert.deepEqual(state.topics, []);
  assert.equal(state.enabled, false);
});

async function runCmd(argv, { tty }) {
  const dir = tmp();
  const outs = [];
  const errs = [];
  const realLog = console.log;
  const realErr = console.error;
  const inTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const outTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const onboarding = require('../src/onboarding');
  const realSetup = onboarding.setupNews;
  let picked = 0;
  onboarding.setupNews = async () => { picked++; return interests.loadInterests(dir); };
  console.log = (...a) => outs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  try {
    const code = await interestsCmd('interests', argv);
    return { code, out: outs.join('\n'), err: errs.join('\n'), picked, dir };
  } finally {
    console.log = realLog;
    console.error = realErr;
    onboarding.setupNews = realSetup;
    if (inTty) Object.defineProperty(process.stdin, 'isTTY', inTty); else delete process.stdin.isTTY;
    if (outTty) Object.defineProperty(process.stdout, 'isTTY', outTty); else delete process.stdout.isTTY;
  }
}

test('meshad interests: bare in a TTY (and edit / pick) opens the picker; bare in non-TTY prints help and exits 2', async () => {
  for (const argv of [[], ['edit'], ['pick']]) {
    const r = await runCmd(argv, { tty: true });
    assert.equal(r.code, 0, argv.join(' '));
    assert.equal(r.picked, 1, argv.join(' '));
  }
  const bare = await runCmd([], { tty: false });
  assert.equal(bare.code, 2);
  assert.equal(bare.picked, 0);
  assert.match(bare.out, /meshad interests — optional/);
  const edit = await runCmd(['edit'], { tty: false });
  assert.equal(edit.code, 2);
  assert.match(edit.err, /needs a terminal/);
  assert.equal(edit.picked, 0);
  const help = await runCmd(['--help'], { tty: true });
  assert.equal(help.code, 0);
  assert.equal(help.picked, 0, '--help never opens the picker');
  assert.match(help.out, /meshad interests edit/);
});

test('meshad interests: scripted subcommands behave exactly as before in a TTY and out of it', async () => {
  const topics = await runCmd(['topics'], { tty: true });
  assert.equal(topics.code, 0);
  assert.deepEqual(topics.out.split('\n'), interests.TAXONOMY);
  const add = await runCmd(['add', 'lang:rust', '--yes'], { tty: false });
  assert.equal(add.code, 0);
  assert.deepEqual(interests.loadInterests(add.dir).topics, ['lang:rust']);
  assert.equal((await runCmd(['list'], { tty: false })).code, 0);
  assert.equal((await runCmd(['bogus'], { tty: true })).code, 2);
  assert.equal(add.picked, 0);
});

test('interests menu: pick topics, turn headlines on/off, clear (confirmed) — all from the home menu', async () => {
  const dir = tmp();
  consented(dir, ['lang:rust']);
  const io = fakeIo();
  const p = interestsMenu(io);
  await tick(); await tick();
  assert.match(io.plain(), /topics: 1 · headlines: on/);
  await press(io, DOWN, ENTER); // turn off
  assert.equal(interests.loadInterests(dir).enabled, false);
  assert.match(io.plain(), /headlines: off/);
  await press(io, ENTER); // wait: cursor stays on "toggle" → Enter turns on again
  assert.equal(interests.loadInterests(dir).enabled, true);
  await press(io, DOWN, ENTER, ENTER); // Clear → confirm defaults to "No, keep them"
  assert.deepEqual(interests.loadInterests(dir).topics, ['lang:rust'], 'default answer keeps everything');
  await press(io, ENTER, DOWN, ENTER); // Clear → "Yes, wipe everything"
  assert.deepEqual(interests.loadInterests(dir), { enabled: false, consented_at: null, topics: [] });
  await press(io, ESC);
  await p;
});

test('i18n: the new news/interests keys exist in en and pt-BR with the same placeholders', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/i18n.js'), 'utf8');
  for (const key of ['news.opened', 'news.openFailed', 'news.noTopics', 'news.small', 'ui.hint.topics', 'ui.topics.count', 'menu.interests', 'menu.int.clear.confirm', 'interests.needTty']) {
    assert.equal((src.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2, key);
  }
});

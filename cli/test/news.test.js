'use strict';

/**
 * Optional news panel: local-only interests, consent, generic feed, local
 * filtering, URL sanitization, and `meshad run --news` (alongside an ad, or
 * alone WITHOUT any impression). `run` tests need a real PTY (the renderer only
 * draws on a TTY), provided by util-linux `script`; they skip without it.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFile, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startMockServer } = require('./helpers/mock-server');
const interests = require('../src/interests');
const { NewsCache, filterMatchingItems, sanitizeItem } = require('../src/news');
const { formatNews } = require('../src/news-render');
const { displayWidth } = require('../src/creative');

const BIN = path.join(__dirname, '..', 'bin', 'meshad.js');
const HAS_SCRIPT = process.platform !== 'win32' && spawnSync('script', ['--version'], { stdio: 'ignore' }).status === 0;

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** Run the CLI under a PTY (stdin AND stdout are TTYs); optionally answer the first prompt. */
function pty(args, env, { answer } = {}) {
  return new Promise((resolve) => {
    const cmd = [process.execPath, BIN, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const child = spawn('script', ['-qefc', cmd, '/dev/null'], { env: { ...process.env, ...env } });
    let out = '';
    let answered = false;
    child.stdout.on('data', (d) => {
      out += d;
      if (answer !== undefined && !answered && /\[(y\/N|s\/N)\]/.test(out)) {
        answered = true;
        child.stdin.write(`${answer}\n`);
      }
    });
    child.on('close', (code) => resolve({ code, stdout: out }));
  });
}

async function setup(mockOpts) {
  const mock = await startMockServer(mockOpts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-news-'));
  const env = { MESHAD_CONFIG_DIR: dir, MESHAD_API_URL: mock.url, MESHAD_LANG: 'en', NO_COLOR: '1' };
  const r = await cli(['init', '--yes', '--email', 'news@test.dev'], env);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  const cfgFile = path.join(dir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.min_wait_ms = 2000;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  return { mock, dir, env, cfgFile, cfg };
}

const WAIT_SCRIPT = (ms) => `process.stdout.write("before\\n"); setTimeout(() => process.stdout.write("after\\n"), ${ms});`;

// ── interests: pure helpers ───────────────────────────────────────────────

test('interests: defaults are all OFF; activation needs consent + topics + (enabled or --news)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-int-'));
  assert.deepEqual(interests.loadInterests(dir), { enabled: false, consented_at: null, topics: [] });
  assert.equal(interests.isNewsActive(interests.defaultState()), false);
  assert.equal(interests.isNewsActive(interests.defaultState(), { flagNews: true }), false);
  const consented = { enabled: false, consented_at: '2026-01-01T00:00:00Z', topics: ['lang:rust'] };
  assert.equal(interests.isNewsActive(consented), false);
  assert.equal(interests.isNewsActive(consented, { flagNews: true }), true);
  assert.equal(interests.isNewsActive({ ...consented, enabled: true }), true);
  assert.equal(interests.isNewsActive({ ...consented, enabled: true, topics: [] }), false);
  assert.equal(interests.isNewsActive({ ...consented, enabled: true, consented_at: null }), false);
});

test('interests: validate/add/remove are strict and idempotent; file is 0600 and drops junk on load', () => {
  assert.equal(interests.validateTopics(['lang:rust', 'nope']).ok, false);
  assert.deepEqual(interests.validateTopics(['lang:rust', 'lang:rust']), { ok: true, topics: ['lang:rust'] });
  let s = interests.addTopics(interests.defaultState(), ['lang:rust', 'ai:llm']);
  s = interests.addTopics(s, ['lang:rust']);
  assert.deepEqual(s.topics, ['lang:rust', 'ai:llm']);
  assert.deepEqual(interests.removeTopics(s, ['lang:rust']).topics, ['ai:llm']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-int-'));
  interests.saveInterests(dir, { ...s, consented_at: 'x' });
  assert.equal(fs.statSync(path.join(dir, 'interests.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, 'interests.json'), JSON.stringify({ enabled: true, topics: ['lang:rust', 'evil:topic'] }));
  assert.deepEqual(interests.loadInterests(dir).topics, ['lang:rust']);
});

// ── news cache: sanitization, filtering, rotation, fail-closed ────────────

test('news: unsafe URLs / tracking params / control chars are rejected or stripped', () => {
  const ok = { title: 'T', url: 'https://example.com/a', topics: ['lang:go'] };
  assert.ok(sanitizeItem(ok));
  assert.equal(sanitizeItem({ ...ok, url: 'http://example.com/a' }), null, 'insecure');
  assert.equal(sanitizeItem({ ...ok, url: 'https://example.com/a?utm_source=x' }), null, 'utm');
  assert.equal(sanitizeItem({ ...ok, url: 'https://example.com/a?fbclid=1' }), null, 'fbclid');
  assert.equal(sanitizeItem({ ...ok, url: 'https://example.com/a?ref=hn' }), null, 'ref');
  assert.equal(sanitizeItem({ ...ok, url: 'https://u:p@example.com/a' }), null, 'credentials');
  assert.equal(sanitizeItem({ ...ok, url: 'javascript:alert(1)' }), null);
  assert.equal(sanitizeItem({ ...ok, topics: ['bogus'] }), null, 'topics outside the taxonomy');
  const dirty = sanitizeItem({ ...ok, title: 'Hi\x1b[31m red\x07\nthere', source: '\x1b]0;pwn\x07src' });
  assert.ok(!/[\x00-\x1f\x7f]/.test(dirty.title + dirty.source), 'no control chars survive');
  assert.match(dirty.title, /^Hi red/);
});

test('news: filterMatchingItems keeps feed order; empty topics or no match → []', () => {
  const items = ['lang:rust', 'lang:go', 'ai:llm', 'lang:rust'].map((t, i) => sanitizeItem({ title: `T${i}`, url: `https://x.dev/${i}`, topics: [t] }));
  assert.deepEqual(filterMatchingItems(items, ['lang:rust']).map((i) => i.title), ['T0', 'T3']);
  assert.deepEqual(filterMatchingItems(items, ['ai:llm', 'lang:go']).map((i) => i.title), ['T1', 'T2']);
  assert.deepEqual(filterMatchingItems(items, []), []);
  assert.deepEqual(filterMatchingItems(items, ['topic:web']), []);
});

test('news: NewsCache fetches with no query/key, caches atomically, rotates, and fails closed offline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-nc-'));
  const calls = [];
  const items = [0, 1, 2].map((n) => ({ title: `Rust ${n}`, url: `https://x.dev/${n}`, topics: ['lang:rust'] }))
    .concat([{ title: 'Bad', url: 'http://x.dev/bad', topics: ['lang:rust'] }]);
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ ttl_seconds: 900, items }) };
  };
  let t = 1_000_000;
  const nc = new NewsCache({ dir, apiUrl: 'https://api.test', fetchImpl, now: () => t });
  const feed = await nc.getFeed();
  assert.equal(feed.length, 3, 'the insecure item was dropped');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/v1/news/feed', 'no query string');
  assert.equal(calls[0].opts.headers, undefined, 'no auth header');
  assert.equal(fs.statSync(path.join(dir, 'news-cache.json')).mode & 0o777, 0o600);
  await nc.getFeed();
  assert.equal(calls.length, 1, 'fresh cache → no refetch');

  const seen = [];
  for (let i = 0; i < 4; i++) seen.push(nc.nextHeadlines(feed, ['lang:rust'], 2).map((x) => x.title));
  assert.deepEqual(seen[0], ['Rust 0', 'Rust 1']);
  assert.deepEqual(seen[1], ['Rust 2', 'Rust 0'], 'cursor rotates and wraps');
  assert.notDeepEqual(seen[0], seen[2]);
  assert.deepEqual(nc.nextHeadlines(feed, ['topic:web']), []);

  // stale-while-revalidate serves the old items; cold + offline → []
  t += 901 * 1000;
  assert.equal((await nc.getFeed()).length, 3);
  const cold = new NewsCache({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-nc-')), apiUrl: 'https://api.test', fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(await cold.getFeed(), []);
});

// ── rendering ─────────────────────────────────────────────────────────────

test('news-render: labeled, never "sponsored", never wider than the terminal, fail-closed when narrow', () => {
  const items = [
    sanitizeItem({ title: 'A very long headline '.repeat(6), url: 'https://example.com/some/long/path', topics: ['lang:rust'] }),
    sanitizeItem({ title: 'Second', url: 'https://example.org/x', topics: ['ai:llm'] }),
  ];
  assert.deepEqual(formatNews(items, 39), [], 'narrow → nothing');
  assert.deepEqual(formatNews([], 120), []);
  for (const cols of [40, 60, 80, 120]) {
    for (const standalone of [false, true]) {
      const lines = formatNews(items, cols, { standalone });
      assert.ok(lines.length >= 1 && lines.length <= 2);
      for (const l of lines) {
        const plain = l.replace(/\x1b\[[0-9;]*m/g, '');
        assert.ok(displayWidth(plain) <= cols - 1, `fits ${cols}: ${displayWidth(plain)}`);
        assert.doesNotMatch(plain, /sponsored/i);
        assert.doesNotMatch(plain, /[\x00-\x08\x0b-\x1f\x7f]/);
      }
      const last = lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '');
      assert.equal(/news · \(meshad pause\)/.test(last), standalone, `hint iff standalone (cols ${cols})`);
    }
  }
  assert.match(formatNews(items, 200)[0], /\[rust\] A very long headline/);
});

// ── commands: consent ─────────────────────────────────────────────────────

test('interests cmd: off by default; add needs consent (non-TTY without --yes exits 2, writes nothing)', async () => {
  const { mock, dir, env } = await setup();
  const file = path.join(dir, 'interests.json');
  assert.equal(fs.existsSync(file), false, 'nothing written by init');
  const list = await cli(['interests', 'list'], env);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /no consent/);

  const noYes = await cli(['interests', 'add', 'lang:rust'], env);
  assert.equal(noYes.code, 2);
  assert.match(noYes.stdout, /ONLY on this computer/, 'consent text shown');
  assert.match(noYes.stdout, /\/v1\/news\/feed/);
  assert.match(noYes.stdout, /never uploaded/);
  assert.match(noYes.stderr, /--yes/);
  assert.equal(fs.existsSync(file), false);

  const ok = await cli(['interests', 'add', 'lang:rust', 'ai:llm', '--yes'], env);
  assert.equal(ok.code, 0, ok.stderr);
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(st.topics, ['lang:rust', 'ai:llm']);
  assert.ok(st.consented_at);
  assert.equal(st.enabled, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // already consented: no prompt, even without --yes
  const more = await cli(['interests', 'add', 'topic:web'], env);
  assert.equal(more.code, 0, more.stderr);
  const rm = await cli(['interests', 'remove', 'ai:llm'], env);
  assert.equal(rm.code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).topics, ['lang:rust', 'topic:web']);

  const dis = await cli(['interests', 'disable'], env);
  assert.equal(dis.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, false);
  assert.equal((await cli(['interests', 'show'], env)).code, 0, 'show is an alias of list');
  const status = await cli(['status'], env);
  assert.match(status.stdout, /news\s+disabled · 2 topic\(s\) saved/);
  await mock.close();
});

test('interests cmd: unknown topic exits 2 listing valid ones; nothing written', async () => {
  const { mock, dir, env } = await setup();
  const r = await cli(['interests', 'add', 'lang:cobol', '--yes'], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /lang:cobol/);
  assert.match(r.stderr, /lang:typescript.*topic:web/s);
  assert.equal(fs.existsSync(path.join(dir, 'interests.json')), false);
  const topics = await cli(['interests', 'topics'], env);
  assert.deepEqual(topics.stdout.trim().split('\n'), interests.TAXONOMY);
  assert.equal((await cli(['interests', 'bogus'], env)).code, 2);
  await mock.close();
});

test('interests cmd: interactive decline writes nothing and exits 0; accept consents', { skip: !HAS_SCRIPT && 'needs util-linux script' }, async () => {
  const { mock, dir, env } = await setup();
  const no = await pty(['interests', 'add', 'lang:rust'], env, { answer: 'n' });
  assert.equal(no.code, 0, no.stdout);
  assert.match(no.stdout, /nothing was written/);
  assert.equal(fs.existsSync(path.join(dir, 'interests.json')), false);

  const yes = await pty(['interests', 'add', 'lang:rust'], env, { answer: 'y' });
  assert.equal(yes.code, 0, yes.stdout);
  assert.deepEqual(interests.loadInterests(dir).topics, ['lang:rust']);
  assert.ok(interests.loadInterests(dir).consented_at);
  await mock.close();
});

test('interests cmd: clear resets state and removes the headline cache; pt-BR consent exists', async () => {
  const { mock, dir, env } = await setup();
  await cli(['interests', 'add', 'lang:rust', '--yes'], env);
  fs.writeFileSync(path.join(dir, 'news-cache.json'), '{}');
  const r = await cli(['interests', 'clear'], env);
  assert.equal(r.code, 0);
  assert.deepEqual(interests.loadInterests(dir), { enabled: false, consented_at: null, topics: [] });
  assert.equal(fs.existsSync(path.join(dir, 'news-cache.json')), false);

  const pt = await cli(['interests', 'add', 'lang:go', '--yes'], { ...env, MESHAD_LANG: 'pt-BR' });
  assert.equal(pt.code, 0, pt.stderr);
  assert.match(pt.stdout, /SOMENTE neste computador/);
  await mock.close();
});

// ── privacy / egress ──────────────────────────────────────────────────────

test('privacy: status --explain lists the news endpoint; verify passes and finds no interest in telemetry files', async () => {
  const { mock, dir, env } = await setup();
  await cli(['interests', 'add', 'lang:rust', '--yes'], env);
  const ex = await cli(['status', '--explain'], env);
  assert.match(ex.stdout, /\/v1\/news\/feed\s+GET\s+· generic dev\/AI headlines \(no anon_id, no interests sent\)/);
  await mock.close(); // verify runs offline: the mock has no /v1/transparency/*

  const v = await cli(['verify'], env);
  assert.equal(v.code, 0, v.stdout);
  assert.match(v.stdout, /interests\.json permissions are 0600/);
  assert.match(v.stdout, /no declared interest appears/);

  // a planted leak is caught
  fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify([{ note: 'lang:rust' }]));
  const bad = await cli(['verify'], env);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /declared interest\(s\) found in telemetry files: lang:rust/);
  fs.writeFileSync(path.join(dir, 'queue.json'), '[]');
  fs.chmodSync(path.join(dir, 'interests.json'), 0o644);
  assert.equal((await cli(['verify'], env)).code, 1, 'loose interests.json permissions fail verify');
});

// ── meshad run ────────────────────────────────────────────────────────────

test('run: news stays OFF by default and with --news but no interests (notice on stderr, no feed request)', { skip: !HAS_SCRIPT && 'needs util-linux script' }, async () => {
  const { mock, env } = await setup();
  const off = await pty(['run', '--', process.execPath, '-e', WAIT_SCRIPT(5500)], env);
  assert.equal(off.code, 0, off.stdout);
  assert.doesNotMatch(off.stdout, /Rust blog|\[rust\]/);
  assert.equal(mock.received.news.length, 0, 'news feed never requested without opt-in');

  const flag = await pty(['run', '--news', '--', process.execPath, '-e', WAIT_SCRIPT(500)], env);
  assert.match(flag.stdout, /no interests configured/, 'non-blocking notice');
  assert.equal(mock.received.news.length, 0);
  await mock.close();
});

test('run --news: headlines ride along with the ad; the ad and its billing are untouched; feed request is anonymous', { skip: !HAS_SCRIPT && 'needs util-linux script' }, async () => {
  const { mock, dir, env } = await setup();
  await cli(['interests', 'add', 'lang:rust', '--yes'], env);
  const r = await pty(['run', '--', process.execPath, '-e', WAIT_SCRIPT(7000)], env);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /MockTool \d/, 'the ad is shown');
  assert.match(r.stdout, /sponsored/);
  assert.match(r.stdout, /\[rust\] The Rust blog: releases/, 'matching headline shown');
  assert.doesNotMatch(r.stdout, /OWASP|What's new in Python/, 'non-matching topics never shown');

  const imps = mock.received.events.filter((e) => e.event === 'impression');
  assert.equal(imps.length, 1, 'exactly one impression, for the ad');
  assert.match(imps[0].ad_id, /^ad_mock/);
  assert.ok(imps[0].duration_ms >= 2000);

  // egress privacy: bare GET, no query, no key, no anon_id anywhere
  assert.ok(mock.received.news.length >= 1);
  for (const n of mock.received.news) {
    assert.equal(n.search, '');
    assert.equal(n.auth, null);
    assert.doesNotMatch(n.url, /anon_id|lang:|interest/);
  }
  const allEvents = JSON.stringify(mock.received.batches);
  assert.doesNotMatch(allEvents, /lang:rust|interest|news/i, 'no interest or news data in telemetry');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8') + (fs.existsSync(path.join(dir, 'last-batch.json')) ? fs.readFileSync(path.join(dir, 'last-batch.json'), 'utf8') : ''), /lang:rust/);
  await mock.close();
});

test('run --news: with the frequency cap hit, headlines show alone and NO impression is emitted', { skip: !HAS_SCRIPT && 'needs util-linux script' }, async () => {
  const { mock, env, cfgFile, cfg } = await setup();
  await cli(['interests', 'add', 'lang:rust', '--yes'], env);
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, frequency_cap_h: 0 }));
  const r = await pty(['run', '--', process.execPath, '-e', WAIT_SCRIPT(6000)], env);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /\[rust\] The Rust blog: releases/, 'headline shown without an ad');
  assert.match(r.stdout, /news · \(meshad pause\)/, 'standalone hint');
  assert.doesNotMatch(r.stdout, /sponsored|MockTool/);
  const types = mock.received.events.map((e) => e.event);
  assert.ok(types.includes('idle_start') && types.includes('idle_end'));
  assert.ok(!types.includes('impression'), 'news is never billed');
  await mock.close();
});

test('run: after `interests disable`, plain run shows no news but --news does (still unbilled)', { skip: !HAS_SCRIPT && 'needs util-linux script' }, async () => {
  const { mock, env, cfgFile, cfg } = await setup();
  assert.equal((await cli(['interests', 'add', 'lang:rust', '--yes'], env)).code, 0);
  assert.equal((await cli(['interests', 'disable'], env)).code, 0);
  // frequency cap hit → no ad, so any impression could only come from news
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, frequency_cap_h: 0 }));

  const plain = await pty(['run', '--', process.execPath, '-e', WAIT_SCRIPT(5500)], env);
  assert.equal(plain.code, 0, plain.stdout);
  assert.doesNotMatch(plain.stdout, /Rust blog|\[rust\]/, 'disabled → no news on plain run');
  assert.equal(mock.received.news.length, 0, 'no feed request while disabled');

  const flagged = await pty(['run', '--news', '--', process.execPath, '-e', WAIT_SCRIPT(6000)], env);
  assert.equal(flagged.code, 0, flagged.stdout);
  assert.match(flagged.stdout, /\[rust\] The Rust blog: releases/, '--news overrides disabled for this run');
  assert.ok(mock.received.news.length >= 1);
  assert.ok(!mock.received.events.some((e) => e.event === 'impression'), 'news is never billed');
  await mock.close();
});

test('run --news: with no ad in the pack,headlines show alone and NO impression is emitted', { skip: !HAS_SCRIPT && 'needs util-linux script' }, async () => {
  const { mock, env } = await setup({ noAds: true });
  await cli(['interests', 'add', 'lang:python', '--yes'], env);
  const r = await pty(['run', '--', process.execPath, '-e', WAIT_SCRIPT(6000)], env);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /\[python\] What's new in Python/);
  assert.ok(!mock.received.events.some((e) => e.event === 'impression'));
  await mock.close();
});

'use strict';

/** Colour layer, framebuffer, row diff, streaks, freeze/share cards, themed play session — no TTY needed. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const term = require('../src/play/term');
const streak = require('../src/play/streak');
const cards = require('../src/play/cards');
const views = require('../src/play/views');
const bridge = require('../src/play/bridge');
const runner = require('../src/play/runner');
const termo = require('../src/play/termo');
const i18n = require('../src/i18n');
const { PlaySession } = require('../src/play/session');
const { selectPrompt } = require('../src/menu');
const { PassThrough } = require('node:stream');
const { displayWidth } = require('../src/creative');

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-term-'));
const T = (k, v) => i18n.t(k, v);

// ── colour depth ────────────────────────────────────────────────────────────

test('detectDepth: truecolor / 256 / 16 / none, NO_COLOR wins, non-TTY is plain', () => {
  assert.equal(term.detectDepth({ COLORTERM: 'truecolor', TERM: 'xterm' }, true), 'truecolor');
  assert.equal(term.detectDepth({ COLORTERM: '24bit', TERM: 'xterm' }, true), 'truecolor');
  assert.equal(term.detectDepth({ TERM: 'xterm-256color' }, true), '256');
  assert.equal(term.detectDepth({ TERM: 'screen' }, true), '16');
  assert.equal(term.detectDepth({}, true), '16');
  assert.equal(term.detectDepth({ COLORTERM: 'truecolor', NO_COLOR: '1' }, true), 'none');
  assert.equal(term.detectDepth({ COLORTERM: 'truecolor', NO_COLOR: '' }, true), 'none', 'any value, even empty');
  assert.equal(term.detectDepth({ COLORTERM: 'truecolor' }, false), 'none', 'not a TTY');
  assert.equal(term.detectDepth({ COLORTERM: 'truecolor', TERM: 'dumb' }, true), 'none');
});

test('makeStyle maps one palette to each depth; depth none is the identity', () => {
  assert.equal(term.makeStyle('truecolor').paint('x', { fg: 'cyan' }), '\x1b[38;2;0;229;255mx\x1b[0m');
  assert.match(term.makeStyle('256').paint('x', { bg: 'panel' }), /^\x1b\[48;5;\d+mx\x1b\[0m$/);
  assert.match(term.makeStyle('16').paint('x', { fg: 'cyan', bold: true }), /^\x1b\[1;(3\d|9\d)mx\x1b\[0m$/);
  const none = term.makeStyle('none');
  assert.equal(none.paint('x', { fg: 'cyan', bold: true }), 'x');
  assert.equal(none.gradient('abc', 'cyan', 'magenta'), 'abc');
  assert.equal(none.on, false);
  // every palette entry resolves at every depth
  for (const name of Object.keys(term.PALETTE)) for (const d of ['16', '256', 'truecolor']) assert.ok(term.colorCode(d, 'fg', name), `${name}@${d}`);
});

// ── framebuffer ─────────────────────────────────────────────────────────────

test('Framebuffer half-block mode: two pixel rows per text row', () => {
  const fb = new term.Framebuffer(4, 2);
  fb.px(0, 0, 'cyan'); // top half only
  fb.px(1, 1, 'cyan'); // bottom half only
  fb.px(2, 0, 'cyan'); fb.px(2, 1, 'magenta'); // both, different
  fb.px(3, 2, 'lime'); fb.px(3, 3, 'lime'); // second text row, both same
  const plain = fb.toLines(term.makeStyle('none'));
  assert.deepEqual(plain, ['▀▄▀', '   █']);
  const colour = fb.toLines(term.makeStyle('truecolor'));
  assert.match(colour[0], /38;2;0;229;255;48;2;11;16;32m▀/, 'top pixel is fg over the cell background');
  assert.match(colour[0], /38;2;0;229;255;48;2;255;43;214m▀/, 'top fg + bottom bg in one cell');
  assert.equal(strip(colour[0]).length, 4, 'every row is exactly w cells');
  fb.px(0, 0, null);
  assert.equal(fb.toLines(term.makeStyle('none'))[0][0], ' ', 'null erases');
  fb.text(0, 0, 'ab', { fg: 'ink' });
  assert.equal(fb.toLines(term.makeStyle('none'))[0].slice(0, 2), 'ab');
});

// ── diff ────────────────────────────────────────────────────────────────────

test('rowsPatch rewrites only changed rows and writes nothing when the frame is unchanged', () => {
  const a = ['one', 'two', 'three'];
  assert.equal(term.rowsPatch(a, [...a]), '');
  assert.deepEqual(term.diffRows(a, ['one', 'TWO', 'three']), [1]);
  const patch = term.rowsPatch(a, ['one', 'TWO', 'three']);
  assert.match(patch, /^\x1b\[2;1HTWO\x1b\[0m\x1b\[K$/);
  assert.doesNotMatch(patch, /one|three/);
  assert.deepEqual(term.diffRows(a, ['one']), [1, 2], 'shrinking clears the dropped rows');
  assert.match(term.rowsPatch(a, ['one']), /\x1b\[2;1H\x1b\[0m\x1b\[K\x1b\[3;1H/);
  assert.equal(term.rowsPatch([], ['x']).startsWith('\x1b[1;1H'), true);
});

// ── status bar ──────────────────────────────────────────────────────────────

test('statusBar: game · score · best · streak · state, drops low-priority parts to fit, thinking meter while waiting', () => {
  const base = { game: '▲ RUNNER', score: '120m', best: 340, streak: 3, state: 'waiting', stateLabel: 'thinking', labels: { score: 'score', best: 'best' }, waitMs: 12_000 };
  const none = term.makeStyle('none');
  const wide = term.statusBar({ style: none, cols: 100, ...base });
  for (const part of ['RUNNER', 'score 120m', 'best 340', '🔥 3', 'thinking', '12s']) assert.ok(wide.includes(part), part);
  assert.match(wide, /▰+▱+/);
  const idle = term.statusBar({ style: none, cols: 100, ...base, state: 'idle', stateLabel: 'answer ready' });
  assert.doesNotMatch(idle, /▰|▱/, 'no meter unless the agent is thinking');
  for (const cols of [20, 30, 45, 60, 80]) {
    const bar = term.statusBar({ style: term.makeStyle('truecolor'), cols, ...base });
    assert.ok(displayWidth(strip(bar)) <= cols - 1, `fits ${cols}: ${displayWidth(strip(bar))}`);
    assert.ok(strip(bar).includes('RUNNER'));
  }
  assert.equal(term.pulseFor(0).tier, 0);
  assert.equal(term.pulseFor(10_000).tier, 1);
  assert.equal(term.pulseFor(30_000).tier, 2);
  assert.equal(term.pulseFor(90_000).tier, 3);
  assert.equal(term.pulseFor(90_000).t, 1);
});

// ── streaks ─────────────────────────────────────────────────────────────────

test('streak file: 0600, consecutive days extend, a gap resets, bests persist, junk reads as zeros', () => {
  const dir = tmp();
  assert.deepEqual(streak.load(dir).runner, streak.emptyEntry());
  let e = streak.record(dir, 'runner', '2026-11-22', { score: 100 });
  assert.equal(e.streak, 1);
  e = streak.record(dir, 'runner', '2026-11-22', { score: 80 });
  assert.equal(e.streak, 1, 'same day does not double count');
  assert.equal(e.best, 100);
  e = streak.record(dir, 'runner', '2026-11-23', { score: 250 });
  assert.equal(e.streak, 2);
  e = streak.record(dir, 'runner', '2026-11-30', { score: 10 });
  assert.equal(e.streak, 1, 'a gap resets');
  assert.equal(e.best, 250);
  assert.equal(e.best_streak, 2);
  assert.equal(fs.statSync(path.join(dir, streak.FILE)).mode & 0o777, 0o600);

  // termo: a loss breaks the streak, a win after it restarts at 1
  streak.record(dir, 'termo', '2026-11-22', { score: 5, won: true });
  assert.equal(streak.record(dir, 'termo', '2026-11-23', { score: 0, won: false }).streak, 0);
  assert.equal(streak.record(dir, 'termo', '2026-11-24', { score: 4, won: true }).streak, 1);

  // lapsed streaks display as 0
  assert.equal(streak.liveStreak({ streak: 4, last_date: '2026-11-23' }, '2026-11-24'), 4);
  assert.equal(streak.liveStreak({ streak: 4, last_date: '2026-11-22' }, '2026-11-24'), 0);
  assert.equal(streak.prevDay('2026-03-01'), '2026-02-28');

  fs.writeFileSync(path.join(dir, streak.FILE), JSON.stringify({ runner: { best: -5, streak: 'x', last_date: 'nope' }, termo: 7 }));
  assert.deepEqual(streak.load(dir), Object.fromEntries(streak.GAME_KEYS.map((g) => [g, streak.emptyEntry()])), 'every game always has an entry; junk reads as zeros');
  assert.deepEqual(streak.GAME_KEYS, ['runner', 'termo', 'snake', 'flappy', 'blocks', 'slide', 'chess']);
  assert.deepEqual(streak.record(dir, 'bogus', '2026-11-24', {}), streak.emptyEntry(), 'unknown game is ignored');
});

test('streaks are local only: nothing in play/ that writes them can reach the network', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/play/streak.js'), 'utf8');
  assert.doesNotMatch(src, /require\('(?:node:)?(?:https?|net|dgram)'\)|\.\.\/net|fetch\(/);
});

// ── cards ───────────────────────────────────────────────────────────────────

test('freeze card: big "answer ready" card with score, best and the two keys, centred, in en and pt-BR', () => {
  const plain = cards.freezeCard({ style: term.makeStyle('none'), cols: 80, rows: 16, game: 'Wait Runner', score: '120m', best: 340, streak: 3, t: T });
  const text = plain.join('\n');
  assert.match(text, /✓ {2}YOUR ANSWER IS READY/, 'plain title, no letter-spacing');
  assert.match(text, /score 120m · best 340/);
  assert.match(text, /Esc \/ Enter \/ Q {2}back to your agent/);
  assert.match(text, /Space {2}keep playing \(free-play\)/);
  assert.match(text, /3-day streak/);
  assert.ok(plain.length <= 16);
  for (const l of plain) assert.ok(displayWidth(l) <= 79, `fits: ${displayWidth(l)}`);
  const colour = cards.freezeCard({ style: term.makeStyle('truecolor'), cols: 60, rows: 14, game: 'Termo Dev', score: '2/6', best: 4, t: T });
  assert.ok(colour.some((l) => l.includes('\x1b[38;2;')));
  for (const l of colour) assert.ok(displayWidth(strip(l)) <= 59);
  i18n.init({ lang: 'pt-BR' });
  try {
    const pt = cards.freezeCard({ style: term.makeStyle('none'), cols: 100, rows: 16, game: 'Wait Runner', score: '9m', best: 9, t: T }).join('\n');
    assert.match(pt, /Esc \/ Enter \/ Q {2}voltar ao agente/);
    assert.match(pt, /Espaço {2}continuar jogando/);
  } finally { i18n.init({ lang: 'en' }); }
});

test('share card: termo grid + streak, runner distance bar; text only (no links), plain emoji at NO_COLOR', () => {
  const tm = termo.replay('2026-11-24', ['array', 'cargo']);
  const none = term.makeStyle('none');
  const card = cards.shareCard({ style: none, game: 'termo', date: '2026-11-24', state: tm, streak: 2, t: T }).join('\n');
  assert.match(card, /Termo Dev 2026-11-24 2\/6/);
  assert.match(card, /🟩🟩🟩🟩🟩/);
  assert.match(card, /2-day streak/);
  assert.doesNotMatch(card, /https?:|meshad\.io|\.dev\b/i);
  assert.doesNotMatch(card, /[a-z]{5}\b.*\n.*[a-z]{5}\b/s.test('') ? /x^/ : /\bCARGO\b|\barray\b/i, 'spoiler-free: no letters of the guesses');
  const coloured = cards.shareCard({ style: term.makeStyle('truecolor'), game: 'termo', date: '2026-11-24', state: tm, streak: 0, t: T }).join('\n');
  assert.match(coloured, /38;2;61;220;132m██/, 'green block tiles');

  const run = { score: 240, alive: false };
  const rc = cards.shareCard({ style: none, game: 'runner', date: '2026-11-24', state: run, best: 240, newBest: true, streak: 1, t: T }).join('\n');
  assert.match(rc, /Wait Runner 2026-11-24/);
  assert.match(rc, /▰{20}/, 'a new best fills the bar');
  assert.match(rc, /240m/);
  assert.match(rc, /NEW BEST/);
  const half = cards.shareCard({ style: none, game: 'runner', date: '2026-11-24', state: { score: 100 }, best: 200, t: T }).join('\n');
  assert.match(half, /▰{10}▱{10}/);
});

// ── views & session ─────────────────────────────────────────────────────────

test('runner view: 8 rows, every row the field width, plain at NO_COLOR, deterministic per state', () => {
  const s = runner.create(7);
  for (let i = 0; i < 90; i++) runner.step(s, i === 30);
  const a = views.runnerView(s, { style: term.makeStyle('truecolor'), cols: 80, pulse: term.pulseFor(0), started: true });
  const b = views.runnerView(s, { style: term.makeStyle('truecolor'), cols: 80, pulse: term.pulseFor(0), started: true });
  assert.deepEqual(a, b, 'same state → same frame');
  assert.equal(a.length, views.CELL_ROWS);
  for (const l of a) assert.equal(strip(l).length, runner.FIELD_W);
  const hot = views.runnerView(s, { style: term.makeStyle('truecolor'), cols: 80, pulse: term.pulseFor(60_000), started: true });
  assert.notDeepEqual(a, hot, 'the wait pulse recolours the scene');
  const p = views.runnerView(s, { style: term.makeStyle('none'), cols: 80, pulse: term.pulseFor(0), started: true });
  assert.ok(p.every((l) => !l.includes('\x1b')));
  assert.ok(p.join('\n').includes('▀') || p.join('\n').includes('█'));
});

test('wait pulse is cosmetic: it never changes what the engine computes (replay contract)', () => {
  const dir = tmp();
  const clock = { t: 1000 };
  const a = new PlaySession({ game: 'runner', dir, now: () => clock.t, style: term.makeStyle('none') });
  const b = new PlaySession({ game: 'runner', dir, now: () => clock.t, style: term.makeStyle('none') });
  bridge.writeState(dir, 'waiting', clock.t);
  a.poll(); // a sees a long wait; b never polls a state → free play
  clock.t += 55_000;
  bridge.writeState(dir, 'waiting', clock.t);
  a.poll();
  assert.ok(a.waitMs >= 0);
  for (const s of [a, b]) s.key(' ');
  for (let i = 0; i < 300; i++) {
    if (i % 17 === 0) { a.key(' '); b.key(' '); }
    a.tick(); b.tick();
  }
  assert.deepEqual(a.jumpLog, b.jumpLog);
  assert.equal(a.run.tick, b.run.tick);
  assert.equal(a.run.score, b.run.score);
  assert.deepEqual(runner.simulate(a.run.seed, a.jumpLog, a.run.tick).score, a.run.score, 'the server-side replay agrees');
});

test('session: wait time is measured from the moment play saw the agent start thinking; status bar shows the meter', () => {
  const dir = tmp();
  const clock = { t: 10_000 };
  const s = new PlaySession({ game: 'runner', dir, now: () => clock.t, style: term.makeStyle('none') });
  assert.equal(s.waitMs, 0);
  bridge.writeState(dir, 'waiting', clock.t); s.poll();
  clock.t += 12_500;
  bridge.writeState(dir, 'waiting', clock.t); s.poll(); // heartbeat: ts moves, the wait does not restart
  assert.equal(s.waitMs, 12_500);
  const lines = s.render(100, 24);
  assert.equal(lines.length, 24);
  assert.match(lines[23], /thinking/);
  assert.match(lines[23], /12s/);
  assert.match(lines[23], /▰/);
  bridge.writeState(dir, 'idle', clock.t); s.poll();
  assert.equal(s.waitMs, 0);
});

test('session: the frozen game shows the "answer ready" card instead of the board; Space/Esc hints', () => {
  const dir = tmp();
  const clock = { t: 1000 };
  const s = new PlaySession({ game: 'runner', dir, now: () => clock.t, style: term.makeStyle('none') });
  s.key(' ');
  for (let i = 0; i < 20; i++) s.tick();
  bridge.writeState(dir, 'idle', clock.t); s.poll();
  const text = s.render(80, 24).join('\n');
  assert.match(text.replace(/\s+/g, ''), /YOURANSWERISREADY/);
  assert.match(text, /Esc \/ Enter \/ Q {2}back to your agent/);
  assert.match(text, /score 20m/);
  assert.doesNotMatch(text, /Space = keep playing anyway/, 'the old one-liner is gone');
  s.key(' '); // keep playing
  assert.doesNotMatch(s.render(80, 24).join('\n'), /ANSWER/);
});

test('session: a finished game records the streak locally and shows the share card; NO_COLOR output has no escapes', () => {
  const dir = tmp();
  const s = new PlaySession({ game: 'termo', dir, now: () => Date.UTC(2026, 10, 24), style: term.makeStyle('none') });
  for (const k of 'cargo') s.key(k);
  s.key('enter');
  assert.equal(s.shareText.split('\n')[0], 'Termo Dev 2026-11-24 1/6', 'copy string unchanged');
  assert.ok(s.shareCardLines().length > 0);
  const e = streak.load(dir).termo;
  assert.equal(e.streak, 1);
  assert.equal(e.best, 6);
  const out = s.render(80, 30);
  assert.ok(out.every((l) => !l.includes('\x1b')), 'plain');
  assert.match(out.join('\n'), /1-day streak|🔥 1/);

  const coloured = new PlaySession({ game: 'termo', dir: tmp(), now: () => Date.UTC(2026, 10, 24), style: term.makeStyle('truecolor') });
  for (const k of 'array') coloured.key(k);
  coloured.key('enter');
  const board = coloured.render(80, 24).join('\n');
  assert.match(board, /48;2;61;220;132m/, 'green tile');
  assert.match(board, /48;2;245;197;24m/, 'gold tile');
  assert.match(board, /48;2;58;66;96m/, 'slate tile / key');
});

test('termo keyboard heatmap: best known mark per letter (green beats yellow beats grey)', () => {
  const tm = termo.replay('2026-11-24', ['array', 'cargo']);
  const st = views.keyStates(tm);
  assert.equal(st.r, 'G'); // cargo: r in the right place
  assert.equal(st.a, 'G');
  assert.equal(Object.keys(st).length, new Set('arraycargo').size);
  const plain = views.termoView(tm, { style: term.makeStyle('none'), rows: 24, buffer: '', wordLen: 5, maxGuesses: 6 }).join('\n');
  assert.match(plain, /\[C\]/);
});

// ── menu widgets ────────────────────────────────────────────────────────────

function fakeIo({ columns = 80, isTTY = true } = {}) {
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const chunks = [];
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.isTTY = isTTY;
  stdout.on('data', (d) => chunks.push(String(d)));
  return { stdin, stdout, out: () => chunks.join('') };
}

test('selectPrompt: colourful highlight bar with a colour env, plain without; keys unchanged', async () => {
  const opts = [{ value: 'a', label: 'Alpha', hint: 'first' }, { value: 'b', label: 'Beta' }];
  const io = fakeIo();
  const p = selectPrompt({ title: 'Pick', options: opts, stdin: io.stdin, stdout: io.stdout, env: { COLORTERM: 'truecolor' } });
  io.stdin.write('\x1b[B');
  io.stdin.write('\r');
  assert.equal(await p, 'b');
  assert.match(io.out(), /48;2;31;40;80m/, 'panel-coloured highlight bar');

  const plain = fakeIo();
  const q = selectPrompt({ title: 'Pick', options: opts, stdin: plain.stdin, stdout: plain.stdout, env: { COLORTERM: 'truecolor', NO_COLOR: '1' } });
  plain.stdin.write('\r');
  assert.equal(await q, 'a');
  assert.doesNotMatch(plain.out(), /\x1b\[[0-9;]*m/, 'NO_COLOR: no SGR at all');
  assert.match(plain.out(), /❯ Alpha {2}first/);
});

test('skin accent comes from the ad\'s signed render.color only (closed names → palette), else the default palette', () => {
  const { skinAccent } = require('../src/play/skin');
  assert.equal(skinAccent({ render: { color: 'magenta' } }), 'magenta');
  assert.equal(skinAccent({ render: { color: 'green' } }), 'lime');
  assert.equal(skinAccent({ render: { color: '#ff0000' } }), null, 'no free-form colours from an advertiser');
  assert.equal(skinAccent({ render: { color: '__proto__' } }), null);
  assert.equal(skinAccent(null), null);
  const s = new PlaySession({ game: 'termo', dir: tmp(), skinAccent: 'amber', style: term.makeStyle('truecolor') });
  assert.match(s.render(80, 24)[0], /48;2;255;176;0m ▦ TERMO/);
});

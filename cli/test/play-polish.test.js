'use strict';

/** Escopo 1 — game polish: help, glyphs, highlight bar, card alignment, cursor safety, freeze keys, hints, restart, small panes. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');

const term = require('../src/play/term');
const streak = require('../src/play/streak');
const cards = require('../src/play/cards');
const bridge = require('../src/play/bridge');
const i18n = require('../src/i18n');
const { PlaySession, GAMES } = require('../src/play/session');
const { runTty } = require('../src/play/ui');
const { selectPrompt } = require('../src/menu');
const { playMenu } = require('../src/commands/play');
const { showNews } = require('../src/news-view');
const { gradientBox } = require('../src/play/box');
const { displayWidth } = require('../src/creative');

const NOW = Date.UTC(2026, 10, 24);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-polish-'));
const plain = term.makeStyle('none');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const T = (k, v) => i18n.t(k, v);
const mk = (game, { dir = tmp(), style = plain, clock = { t: NOW } } = {}) => ({ s: new PlaySession({ game, dir, now: () => clock.t, style }), dir, clock });

function fakeIo({ columns = 80, rows = 24 } = {}) {
  const stdin = new PassThrough();
  stdin.setRawMode = () => {};
  const chunks = [];
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = true;
  stdout.on('data', (d) => chunks.push(String(d)));
  return { stdin, stdout, out: () => chunks.join('') };
}
const tick = () => new Promise((r) => setImmediate(r));

// ── nits ────────────────────────────────────────────────────────────────────

test('meshad --help lists all seven games on the play line', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '../bin/meshad.js'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /meshad play \[runner\|termo\|snake\|flappy\|blocks\|slide\|chess\]/);
});

test('help lines never glue two arrow glyphs together (← → not ←→), in both languages', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/i18n.js'), 'utf8');
  assert.doesNotMatch(src, /[←→↑↓][←→↑↓]/);
  for (const lang of ['en', 'pt-BR']) {
    i18n.init({ lang });
    try { assert.match(T('play.keys.blocks'), /← →/); } finally { i18n.init({ lang: 'en' }); }
  }
});

test('highlight bar: the two spaces before the hint carry the bar colour (no black gap)', async () => {
  const io = fakeIo();
  const p = selectPrompt({ title: 'Pick', options: [{ value: 'a', label: 'Alpha', hint: 'first' }, { value: 'b', label: 'Beta' }], stdin: io.stdin, stdout: io.stdout, env: { COLORTERM: 'truecolor' } });
  io.stdin.write('\r');
  await p;
  const row = io.out().split('\n').find((l) => l.includes('Alpha'));
  assert.match(row, /\x1b\[[0-9;]*48;2;31;40;80m {2}\x1b\[0m\x1b\[[0-9;]*48;2;31;40;80m[^\x1b]*first/, 'spaces painted with the panel background');
  const bare = strip(row);
  assert.match(bare, /Alpha {2}first/);
});

test('gradientBox: every row is exactly as wide as the border, with accents, ✓, ★ and clipping', () => {
  for (const style of [plain, term.makeStyle('truecolor'), term.makeStyle('16')]) {
    for (const [label, maxWidth] of [['SUA RESPOSTA ESTÁ PRONTA', 60], ['Esc / Enter / Q  voltar ao agente', 60], ['x'.repeat(80), 30]]) {
      const inner = [{ text: style.paint(label, { fg: 'ink' }), plain: label }, { text: '', plain: '' }, { text: style.paint('✓ ★ ç ã', { fg: 'lime' }), plain: '✓ ★ ç ã' }];
      for (const align of ['center', 'left']) {
        const box = gradientBox({ style, inner, maxWidth, from: 'lime', to: 'cyan', bg: style.on ? 'panel' : null, align });
        const widths = new Set(box.lines.map((l) => displayWidth(strip(l))));
        assert.equal(widths.size, 1, `${align}/${style.depth || ''}/${label.slice(0, 10)}: ${[...widths]}`);
        assert.equal([...widths][0], box.width);
      }
    }
  }
  // even if `plain` drifted from the styled text, the border stays aligned
  const drift = gradientBox({ style: plain, inner: [{ text: 'abcdefghij', plain: 'abc' }], maxWidth: 40, from: 'lime', to: 'cyan' });
  assert.equal(new Set(drift.lines.map((l) => displayWidth(l))).size, 1);
});

test('freeze card: clear layout, one key back and Space to continue, pt-BR keeps the same shape', () => {
  for (const lang of ['en', 'pt-BR']) {
    i18n.init({ lang });
    try {
      const lines = cards.freezeCard({ style: term.makeStyle('truecolor'), cols: 80, rows: 16, game: 'Mate do Dia', score: '4', best: 9, streak: 2, t: T });
      const body = lines.filter((l) => /[│╭╰]/.test(strip(l)));
      assert.equal(new Set(body.map((l) => displayWidth(strip(l)))).size, 1, `${lang}: aligned right border`);
      const text = strip(lines.join('\n'));
      assert.match(text, /Esc \/ Enter \/ Q/);
      assert.match(text, lang === 'en' ? /Space {2}keep playing/ : /Espaço {2}continuar/);
      assert.doesNotMatch(text, /🔥/, 'no emoji inside the box (width differs per terminal)');
    } finally { i18n.init({ lang: 'en' }); }
  }
});

// ── freeze: one key back to the agent ───────────────────────────────────────

test('frozen: Esc, Enter or Q return to the agent in one key; Space keeps playing; letters do nothing', () => {
  for (const game of GAMES) {
    for (const key of ['esc', 'enter', 'q']) {
      const { s, dir, clock } = mk(game);
      bridge.writeState(dir, 'idle', clock.t); s.poll();
      assert.equal(s.gate, 'frozen');
      s.key('x');
      assert.equal(s.done, false, `${game}: other keys are swallowed`);
      s.key(key);
      assert.equal(s.done, true, `${game}: ${key} leaves`);
    }
    const { s, dir, clock } = mk(game);
    bridge.writeState(dir, 'idle', clock.t); s.poll();
    s.key(' ');
    assert.equal(s.done, false);
    assert.equal(s.gate, 'run', `${game}: Space continues in free-play`);
  }
});

test('not frozen: Q still types in termo/chess and Enter does not leave', () => {
  const { s } = mk('termo');
  s.key('q'); s.key('enter');
  assert.equal(s.done, false);
  assert.equal(s.buffer, 'q');
});

// ── cursor safety ───────────────────────────────────────────────────────────

test('runTty hides the cursor, and restores it (+ alt screen) on Esc', async () => {
  const io = fakeIo();
  const { s } = mk('snake');
  const run = runTty(s, { stdin: io.stdin, stdout: io.stdout });
  await tick();
  assert.ok(io.out().startsWith('\x1b[?1049h\x1b[?25l'), 'alt screen + hidden cursor first');
  io.stdin.write('\x1b');
  await run;
  assert.ok(io.out().endsWith('\x1b[?25h\x1b[?1049l'));
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`runTty restores the terminal on ${sig} and drops its process listeners`, async () => {
    const before = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException'].map((e) => process.listenerCount(e));
    const io = fakeIo();
    const { s } = mk('flappy');
    const run = runTty(s, { stdin: io.stdin, stdout: io.stdout });
    await tick();
    assert.ok(process.listenerCount(sig) > before[1 + ['SIGINT', 'SIGTERM', 'SIGHUP'].indexOf(sig)], 'guard installed while the game runs');
    process.emit(sig);
    await run;
    assert.ok(io.out().endsWith('\x1b[?25h\x1b[?1049l'), `${sig}: cursor shown, alt screen left`);
    assert.deepEqual(['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException'].map((e) => process.listenerCount(e)), before, 'no listener leaked');
  });
}

test('guardTerminal: an uncaught error restores the terminal before the process dies; a bare signal exits 128+n', () => {
  let restored = 0;
  const exits = [];
  const realExit = process.exit;
  const realErr = process.stderr.write;
  process.exit = (c) => { exits.push(c); };
  process.stderr.write = () => true;
  const release = term.guardTerminal({ restore: () => { restored += 1; } });
  try {
    const h = process.listeners('uncaughtException').at(-1);
    h(new Error('boom'));
    assert.equal(restored, 1);
    assert.deepEqual(exits, [1]);
    process.emit('SIGTERM');
    assert.deepEqual(exits, [1, 143]);
    assert.equal(restored, 2);
  } finally {
    release();
    process.exit = realExit;
    process.stderr.write = realErr;
  }
});

test('menu prompts restore the cursor on SIGTERM and resolve as cancelled', async () => {
  const io = fakeIo();
  const p = selectPrompt({ title: 'Pick', options: [{ value: 'a', label: 'Alpha' }], stdin: io.stdin, stdout: io.stdout });
  assert.ok(io.out().includes('\x1b[?25l'));
  process.emit('SIGTERM');
  assert.equal(await p, null);
  assert.ok(io.out().includes('\x1b[?25h'));
});

test('news view restores the cursor and alt screen on SIGHUP', async () => {
  const io = fakeIo();
  const dir = tmp();
  const run = showNews({ dir, stdin: io.stdin, stdout: io.stdout, env: { NO_COLOR: '1' } });
  await tick(); await tick();
  assert.ok(io.out().includes('\x1b[?1049h\x1b[?25l'));
  process.emit('SIGHUP');
  await run;
  assert.ok(io.out().endsWith('\x1b[?25h\x1b[?1049l'));
});

test('chess prompt is clean: no block / I-beam glyph, a dim example while empty', () => {
  const { s } = mk('chess');
  const empty = s.render(80, 24).join('\n');
  assert.doesNotMatch(empty, /[▌█▏|_]\s*$/m);
  assert.match(empty, /› \(e2e4\)/);
  for (const k of 'e2') s.key(k);
  const typed = s.render(80, 24).join('\n');
  assert.match(typed, /› e2\n/);
  assert.doesNotMatch(typed, /▌/);
});

// ── pause, restart, first-match hint, effects ───────────────────────────────

test('pause is clearly shown with resume / restart / quit hint for every real-time game', () => {
  for (const game of ['runner', 'snake', 'flappy', 'blocks']) {
    const { s } = mk(game);
    s.key(game === 'snake' ? 'right' : ' ');
    s.key('p');
    const text = s.render(80, 24).join('\n');
    assert.match(text, /PAUSED — P resume/, game);
    assert.match(text, /P resume · R restart · Esc quit/, game);
    s.key('p');
    assert.doesNotMatch(s.render(80, 24).join('\n'), /PAUSED/, game);
  }
});

test('R restarts instantly, also from game over (runner, snake, flappy, blocks, slide)', () => {
  const r = mk('runner').s;
  r.key(' ');
  for (let i = 0; i < 400 && r.run.alive; i++) r.tick();
  assert.equal(r.run.alive, false);
  r.key('r');
  assert.equal(r.run.alive, true);
  assert.equal(r.started, false);

  for (const game of ['snake', 'flappy', 'blocks']) {
    const { s } = mk(game);
    s.key(game === 'snake' ? 'right' : ' ');
    for (let i = 0; i < 4000 && !s.g.over; i++) s.tick();
    assert.equal(s.g.over, true, `${game} ends on its own`);
    s.key('r');
    assert.equal(s.g.over, false, `${game}: R after game over`);
    assert.equal(s.g.started, false);
  }
  const sl = mk('slide').s;
  sl.key('left'); sl.key('up');
  sl.key('r');
  assert.equal(sl.g.s.moves, 0);
});

test('termo R after the end replays the word as unscored practice: nothing recorded, shared or submitted', () => {
  const { s, dir } = mk('termo');
  for (const w of ['array', 'cargo']) { for (const k of w) s.key(k); s.key('enter'); }
  const played = streak.load(dir).termo.played;
  assert.ok(s.tm.over);
  s.key('r');
  assert.equal(s.tm.over, false);
  assert.equal(s.practice, true);
  assert.equal(s.result, null);
  assert.match(s.render(80, 24).join('\n'), /practice — this round is not scored/);
  for (const w of ['array', 'array', 'array', 'array', 'array', 'array']) { for (const k of w) s.key(k); s.key('enter'); }
  assert.ok(s.tm.over);
  assert.equal(streak.load(dir).termo.played, played, 'practice does not count');
  assert.equal(s.shareText, null);
  assert.equal(s.result, null);
});

test('first match of each game shows a one-line controls hint; later matches stay clean (persisted locally)', () => {
  const dir = tmp();
  for (const game of GAMES) {
    const first = mk(game, { dir }).s;
    const lines = first.render(80, 24);
    assert.match(lines.join('\n'), /first run — /, `${game}: first match`);
    assert.equal(lines.filter((l) => /first run — /.test(l)).length, 1, 'exactly one line');
    const again = mk(game, { dir }).s; // a later match, new process
    assert.doesNotMatch(again.render(80, 24).join('\n'), /first run — /, `${game}: stays clean`);
    first.key('r'); // a restart inside the same session never brings it back either
    if (game !== 'termo' && game !== 'chess') assert.doesNotMatch(first.render(80, 24).join('\n'), /first run — /);
  }
  const file = path.join(dir, streak.HINTS_FILE);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'local file, 0600');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), [...streak.GAME_KEYS].sort());
  for (const lang of ['en', 'pt-BR']) {
    i18n.init({ lang });
    try { for (const g of GAMES) assert.match(T(`play.first.${g}`), /\S/); } finally { i18n.init({ lang: 'en' }); }
  }
});

test('score pop: a short "+N" flash after scoring, gone after a moment (cosmetic, engine untouched)', () => {
  const { s, clock } = mk('slide');
  const before = JSON.stringify(s.g.s);
  let moved = false;
  for (let i = 0; i < 40 && !moved; i++) {
    s.key(['left', 'up', 'right', 'down'][i % 4]);
    if (s.g.score > 0) moved = true;
  }
  assert.ok(moved, 'a merge happened');
  assert.match(s.render(80, 24).join('\n'), /\+\d+/);
  clock.t += 2000;
  assert.doesNotMatch(s.render(80, 24)[1], /\+\d+/);
  assert.notEqual(before, JSON.stringify(s.g.s));
});

// ── layout: 80x24, narrow panes, too small, colour depths ──────────────────

test('every game fits 80x24 exactly (24 rows, nothing wider than 79) in every colour depth', () => {
  for (const depth of ['truecolor', '256', '16', 'none']) {
    for (const game of GAMES) {
      const { s } = mk(game, { style: term.makeStyle(depth) });
      const lines = s.render(80, 24);
      assert.equal(lines.length, 24, `${game}/${depth}`);
      for (const l of lines) assert.ok(displayWidth(strip(l)) <= 79, `${game}/${depth}: ${displayWidth(strip(l))}`);
      if (depth === 'none') assert.ok(lines.every((l) => !l.includes('\x1b')), `${game}: NO_COLOR is escape-free`);
      if (depth === '16') assert.ok(lines.every((l) => !/\x1b\[(38|48);[25]/.test(l)), `${game}: 16 colours only`);
      if (depth === '256') assert.ok(lines.every((l) => !/\x1b\[(38|48);2;/.test(l)), `${game}: no truecolor in 256 mode`);
    }
  }
});

test('narrow tmux splits: games at their minimum size never wrap and never show the too-small message', () => {
  const MIN = { runner: [30, 14], termo: [26, 16], snake: [28, 14], flappy: [30, 14], blocks: [28, 18], slide: [36, 13], chess: [30, 16] };
  for (const game of GAMES) {
    const [cols, rows] = MIN[game];
    for (const style of [plain, term.makeStyle('truecolor')]) {
      const { s } = mk(game, { style });
      const lines = s.render(cols, rows);
      assert.equal(lines.length, rows, game);
      assert.doesNotMatch(strip(lines.join('\n')), /too small/, game);
      for (const l of lines) assert.ok(displayWidth(strip(l)) <= cols - 1, `${game} ${cols}x${rows}: ${displayWidth(strip(l))}`);
    }
  }
});

test('below the minimum a friendly message replaces the board, fits the pane and says what is needed', () => {
  for (const lang of ['en', 'pt-BR']) {
    i18n.init({ lang });
    try {
      for (const game of GAMES) {
        const { s } = mk(game);
        for (const [cols, rows] of [[20, 8], [12, 4], [80, 5], [10, 1]]) {
          const lines = s.render(cols, rows);
          assert.ok(lines.length <= rows, `${game} ${cols}x${rows}`);
          for (const l of lines) assert.ok(displayWidth(strip(l)) <= Math.max(1, cols - 1), `${game} ${cols}x${rows}`);
        }
        const text = s.render(20, 8).join(' ').replace(/\s+/g, ' ');
        assert.match(text, /\d+x\d+/);
        assert.match(text, lang === 'en' ? /too small/ : /pequeno demais/);
      }
    } finally { i18n.init({ lang: 'en' }); }
  }
});

test('render never throws at awkward sizes while a game runs', () => {
  for (const game of GAMES) {
    const { s } = mk(game);
    s.key(' '); s.key('right');
    for (const [c, r] of [[1, 1], [24, 10], [41, 17], [100, 40], [200, 60]]) assert.doesNotThrow(() => s.render(c, r), `${game} ${c}x${r}`);
  }
});

// ── picker ──────────────────────────────────────────────────────────────────

test('picker: highlighted game shows a short description plus local best, plays and streak; footer keys', async () => {
  const dir = tmp();
  const today = new Date().toISOString().slice(0, 10);
  streak.record(dir, 'runner', today, { score: 120, won: true });
  streak.record(dir, 'snake', today, { score: 7, won: true });
  const io = fakeIo();
  const p = playMenu({ dir, stdin: io.stdin, stdout: io.stdout, runGame: async () => {} });
  await tick();
  assert.match(strip(io.out()), /Dino-style dash/);
  assert.match(strip(io.out()), /best 120 · played 1 · best streak 1/);
  assert.match(strip(io.out()), /↑\/↓ move · Enter play · Esc back/);
  io.stdin.write('\x1b[B\x1b[B'); // Snake
  await tick();
  assert.match(strip(io.out()), /Classic snake/);
  io.stdin.write('\x1b[B\x1b[B\x1b[B\x1b[B'); // Chess: never played
  await tick();
  assert.match(strip(io.out()), /not played yet/);
  io.stdin.write('\x1b');
  assert.equal(await p, 0);
});

// ── per-game accent + score sparkle (cosmetic only) ─────────────────────────

test('each game has its own chip accent unless a verified skin supplies one', () => {
  const want = { runner: 'lime', termo: 'gold', snake: 'green', flappy: 'sky', blocks: 'magenta', slide: 'amber', chess: 'violet' };
  const style = term.makeStyle('truecolor');
  const chip = (game, skinAccent = null) => {
    const s = new PlaySession({ game, dir: tmp(), now: () => NOW, style, skinAccent });
    return s.render(80, 24)[0].split(' ')[0];
  };
  const seen = new Set();
  for (const [game, color] of Object.entries(want)) {
    const expected = style.paint(' X ', { fg: 'night', bg: color, bold: true }).split('X')[0];
    assert.ok(chip(game).startsWith(expected.replace(/ $/, '')) || chip(game).includes(expected.slice(0, expected.indexOf('m') + 1)), game);
    seen.add(chip(game));
  }
  assert.equal(seen.size, 7, 'seven distinct chips');
  const skinned = chip('runner', 'red');
  assert.notEqual(skinned, chip('runner'), 'a skin accent still wins');
});

test('score pop sparkles (alternating ✦/✧) and never changes the score', () => {
  const { s, clock } = mk('snake');
  s.key('right');
  const before = s.g.score;
  s.g.s.score += 1; // simulate a pop-triggering score change on the view side only
  s.updateFx();
  const a = strip(s.render(80, 24).join('\n'));
  clock.t += 200;
  const b = strip(s.render(80, 24).join('\n'));
  assert.match(a, /[✦✧] \+1/);
  assert.notEqual(a.match(/[✦✧] \+1/)[0], b.match(/[✦✧] \+1/)[0], 'sparkle alternates');
  assert.equal(s.g.score, before + 1);
});

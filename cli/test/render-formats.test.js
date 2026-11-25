'use strict';

/** Rich ad formats: text_line, text_block, rich_panel — color, emoji, sanitization. */

const { test } = require('node:test');
const assert = require('node:assert');
const { Writable } = require('node:stream');
const { LineRenderer, formatAd } = require('../src/render');

function fakeTty({ columns = 100, rows = 30 } = {}) {
  const writes = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      writes.push(chunk.toString());
      cb();
    },
  });
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  return { stream, writes };
}

test('formatAd: text_block renders N content lines + one cta/sponsored line', () => {
  const ad = { format: 'text_block', render: { lines: ['Line one', 'Line two'], cta: 'mesh.io/x', color: 'green', emoji: '🚀' } };
  const rows = formatAd(ad, 100);
  assert.equal(rows.length, 3, 'two content lines + cta line');
  assert.ok(rows[0].includes('🚀'), 'emoji prefixes the first line only');
  assert.ok(!rows[1].includes('🚀'));
  assert.ok(rows[2].includes('sponsored'));
  for (const r of rows) assert.ok(r.startsWith('\x1b[32m'), 'green color code applied to every line');
});

test('formatAd: rich_panel draws a bordered box around the content', () => {
  const ad = { format: 'rich_panel', render: { lines: ['Neon — Postgres'], cta: 'mesh.io/neon', color: 'cyan', emoji: '▲' } };
  const rows = formatAd(ad, 100);
  assert.ok(rows.length >= 4, 'top border + content + cta + bottom border');
  assert.ok(rows[0].includes('┌') && rows[0].includes('┐'));
  assert.ok(rows[rows.length - 1].includes('└') && rows[rows.length - 1].includes('┘'));
  assert.ok(rows.some((r) => r.includes('▲') && r.includes('Neon')));
  assert.ok(rows.some((r) => r.includes('sponsored')));
});

test('formatAd: rich_panel degrades to text_block on a narrow terminal', () => {
  const ad = { format: 'rich_panel', render: { lines: ['Neon — Postgres'], cta: 'mesh.io/neon', color: 'cyan' } };
  const rows = formatAd(ad, 30); // below the 40-col threshold
  assert.ok(!rows.some((r) => r.includes('┌')), 'no box on a narrow terminal — never corrupt a small screen');
});

test('formatAd: control characters and ANSI injection in creative content are stripped', () => {
  const ad = { format: 'text_line', render: { lines: ['evil\x1b[31mred\x1b[0mtext\ninjected'], cta: 'mesh.io/x', color: 'dim' } };
  const rows = formatAd(ad, 100);
  const joined = rows.join('');
  assert.ok(!joined.includes('\x1b[31m'), 'no foreign ANSI escape survives from creative content');
  assert.ok(!joined.includes('\n'), 'no newline injection');
});

test('formatAd: unknown/future format falls back to text_line, never throws', () => {
  const ad = { format: 'something_new', render: { text: 'fallback', lines: ['fallback'], cta: 'mesh.io/x', color: 'dim' } };
  const rows = formatAd(ad, 100);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes('fallback'));
});

test('LineRenderer: multi-row render + clear erases exactly the rows drawn', () => {
  const { stream, writes } = fakeTty();
  const r = new LineRenderer(stream);
  const rows = formatAd({ format: 'rich_panel', render: { lines: ['A', 'B'], cta: 'mesh.io/x', color: 'magenta', emoji: '●' } }, 100);
  assert.ok(r.render(rows));
  assert.equal(r.activeHeight, rows.length);
  const drawn = writes[0];
  for (let i = 0; i < rows.length; i++) {
    assert.ok(drawn.includes(`${30 - rows.length + 1 + i};1H`), `row ${i} targeted at the correct screen line`);
  }
  r.clear();
  const cleared = writes[1];
  const clearCount = (cleared.match(/\x1b\[2K/g) || []).length;
  assert.equal(clearCount, rows.length, 'every drawn row gets erased, not just one');
});

test('LineRenderer: no-op and false on non-TTY regardless of format', () => {
  const writes = [];
  const stream = new Writable({ write(c, _e, cb) { writes.push(c.toString()); cb(); } });
  stream.isTTY = false;
  const r = new LineRenderer(stream);
  const rows = formatAd({ format: 'rich_panel', render: { lines: ['A'], cta: 'x', color: 'red' } }, 100);
  assert.equal(r.render(rows), false);
  assert.equal(writes.length, 0);
});

// ── render.colors v1 (brand colour) ──────────────────────────────────────────

test('colors: brand renders as 24-bit, xterm-256 index, nearest basic name, and nothing under NO_COLOR', () => {
  const { formatAd } = require('../src/render');
  const { brandFallbacks } = require('../src/creative');
  const ad = { format: 'text_line', render: { text: 'Acme', cta: 'acme.dev', color: 'cyan', colors: { v: 1, brand: '#ff8800' } } };
  const fb = brandFallbacks('#ff8800');
  const first = (env) => formatAd(ad, 80, 24, env)[0];
  assert.ok(first({ COLORTERM: 'truecolor' }).startsWith('\x1b[38;2;255;136;0m'));
  assert.ok(first({ COLORTERM: '24bit' }).startsWith('\x1b[38;2;255;136;0m'));
  assert.ok(first({ TERM: 'xterm-256color' }).startsWith(`\x1b[38;5;${fb.ansi256}m`));
  assert.ok(first({ TERM: 'xterm' }).startsWith(`\x1b[${{ red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 }[fb.ansi16]}m`));
  const plain = first({ NO_COLOR: '1', COLORTERM: 'truecolor' });
  assert.ok(!plain.includes('\x1b'), 'NO_COLOR: no escape at all');
  assert.match(plain, /sponsored/);
});

test('colors: unknown v, bad hex, extra keys → ignored, render.color is used', () => {
  const { formatAd } = require('../src/render');
  const env = { COLORTERM: 'truecolor' };
  for (const colors of [{ v: 2, brand: '#ff8800' }, { v: 1, brand: '#FF8800' }, { v: 1, brand: 'red' }, { v: 1, brand: '#000000' }, { v: 1, brand: '#ff8800', x: 1 }, 'x', null]) {
    const ad = { format: 'text_line', render: { text: 'Acme', cta: 'c', color: 'magenta', colors } };
    assert.ok(formatAd(ad, 80, 24, env)[0].startsWith('\x1b[35m'), JSON.stringify(colors));
  }
});

test('colors: only synthesized sequences reach the terminal — a hostile brand never gets through', () => {
  const { formatAd } = require('../src/render');
  const ad = { format: 'text_line', render: { text: 'Acme', cta: 'c', color: 'cyan', colors: { v: 1, brand: '#ff8800\x1b]0;pwn\x07' } } };
  const out = formatAd(ad, 80, 24, { COLORTERM: 'truecolor' })[0];
  assert.ok(!out.includes('pwn') && !out.includes('\x07'));
  assert.ok(out.startsWith('\x1b[36m'));
});

test('colors: ascii_panel frame and sponsor row use the brand colour too', () => {
  const { formatAd } = require('../src/render');
  const ad = { format: 'ascii_panel', render: { text: 'A', lines: ['A'], cta: 'a.dev', color: 'cyan', colors: { v: 1, brand: '#ff8800' }, art_lines: [[{ t: ' ACME ' }]] } };
  const lines = formatAd(ad, 80, 24, { COLORTERM: 'truecolor' });
  assert.ok(lines.length > 1);
  assert.ok(lines[0].includes('\x1b[38;2;255;136;0m') && lines[lines.length - 1].includes('\x1b[38;2;255;136;0m'));
  assert.ok(!formatAd(ad, 80, 24, { NO_COLOR: '' }).join('').includes('38;2;'));
});

test('colors: the game accent follows the brand at each depth; unknown v keeps the render.color accent', () => {
  const { skinAccent } = require('../src/play/skin');
  const term = require('../src/play/term');
  const { brandFallbacks } = require('../src/creative');
  const acc = skinAccent({ render: { color: 'green', colors: { v: 1, brand: '#ff8800' } } });
  assert.deepEqual(acc, { brand: '#ff8800' });
  assert.equal(term.makeStyle('truecolor').open({ bg: acc }), '\x1b[48;2;255;136;0m');
  assert.equal(term.makeStyle('256').open({ bg: acc }), `\x1b[48;5;${brandFallbacks('#ff8800').ansi256}m`);
  assert.match(term.makeStyle('16').open({ bg: acc }), /^\x1b\[4[1-6]m$/);
  assert.equal(term.makeStyle('none').open({ bg: acc }), '');
  assert.equal(skinAccent({ render: { color: 'green', colors: { v: 9, brand: '#ff8800' } } }), 'lime');
});

test('colors: ascii_panel art text takes the brand colour at each depth; NO_COLOR emits no colour; no colors keeps the span fg', () => {
  const { brandFallbacks } = require('../src/creative');
  const art = [[{ t: '▌ ', fg: 'cyan' }, { t: 'Acme', fg: 'cyan', bold: true }], [{ t: '▌ ', fg: 'cyan' }, { t: 'ships fast' }]];
  const mk = (colors) => ({ format: 'ascii_panel', render: { text: 'A', lines: ['A'], cta: 'a.dev', color: 'cyan', ...(colors ? { colors } : {}), art_lines: art } });
  const body = (ad, env) => formatAd(ad, 80, 24, env).slice(1, 3).join('');
  const brand = { v: 1, brand: '#ff8800' };
  const fb = brandFallbacks('#ff8800');

  const tc = body(mk(brand), { COLORTERM: 'truecolor' });
  assert.ok(tc.includes('\x1b[1;38;2;255;136;0mAcme'), 'bold title painted in the brand');
  assert.ok(tc.includes('\x1b[38;2;255;136;0mships fast'), 'unstyled line painted too');
  assert.ok(!tc.includes('36m'), 'palette cyan is gone');
  assert.ok(body(mk(brand), { TERM: 'xterm-256color' }).includes(`38;5;${fb.ansi256}mships fast`));
  assert.match(body(mk(brand), { TERM: 'xterm' }), /\x1b\[3[1-6]mships fast/);

  const none = body(mk(brand), { NO_COLOR: '1', COLORTERM: 'truecolor' });
  assert.ok(!/\x1b\[[0-9;]*(3[0-9]|9[0-9]|4[0-9]|10[0-9])m/.test(none), 'NO_COLOR: no colour SGR');
  assert.match(none, /ships fast/);

  assert.ok(body(mk(null), { COLORTERM: 'truecolor' }).includes('36mships') === false && body(mk(null), { COLORTERM: 'truecolor' }).includes('\x1b[1;36mAcme'), 'no colors: span fg stays');
  for (const bad of [{ v: 2, brand: '#ff8800' }, { v: 1, brand: 'red' }]) {
    assert.ok(body(mk(bad), { COLORTERM: 'truecolor' }).includes('\x1b[1;36mAcme'), JSON.stringify(bad));
  }
});

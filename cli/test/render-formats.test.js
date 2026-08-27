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

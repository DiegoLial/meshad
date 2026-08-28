'use strict';

/**
 * ascii_panel: multi-colour terminal art. The security property under test is
 * that colour arrives as *structure* (spans) and the escape bytes are written
 * by us — so widening the creative's expressive range widened nothing about
 * what an advertiser can reach in a developer's terminal.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { Writable } = require('node:stream');
const {
  LineRenderer, formatAd, revealFrames, buildTimeline, Animator, MAX_ROWS_ART, MIN_COLS_ART,
} = require('../src/render');
const { displayWidth } = require('../src/creative');

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

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const AD = {
  format: 'ascii_panel',
  render: {
    cta: 'mesh.io/tb',
    color: 'cyan',
    art_lines: [
      [
        { t: '▄▀█', fg: 'bright_cyan', bold: true },
        { t: ' TERABYTE ', fg: 'bright_white', bold: true },
        { t: '█▀▄', fg: 'bright_cyan', bold: true },
      ],
      [
        { t: ' MÊS GAMER ', fg: 'bright_white', bg: 'magenta', bold: true },
        { t: ' 65% OFF', fg: 'bright_yellow', bold: true },
      ],
    ],
  },
};

test('ascii_panel: several colours coexist on one line', () => {
  const rows = formatAd(AD, 100, 30);
  assert.equal(rows.length, 5, 'panel borders + two art lines + the mandatory sponsored line');
  const codes = rows[1].match(/\x1b\[[0-9;]*m/g) || [];
  assert.ok(codes.length >= 6, 'each span opens and resets its own style');
  assert.ok(rows[1].includes('\x1b[1;96m'), 'bright cyan bold present');
  assert.ok(rows[1].includes('\x1b[1;97m'), 'bright white bold present on the SAME line');
  assert.ok(rows[2].includes('45m'), 'background colour is available');
});

test('ascii_panel: the sponsored label is not optional', () => {
  const rows = formatAd(AD, 100, 30);
  const last = visible(rows[rows.length - 2]); // last row is the panel's bottom border
  assert.ok(last.includes('sponsored'), 'sponsored label always rendered');
  assert.ok(last.includes('meshad pause'), 'pause hint always rendered');
});

test('ascii_panel: every span resets, so no style leaks into the prompt', () => {
  for (const row of formatAd(AD, 100, 30).slice(0, 2)) {
    assert.ok(row.endsWith('\x1b[0m'), `art line must end reset: ${JSON.stringify(row)}`);
  }
});

test('ascii_panel: degrades to a single flattened line on a narrow terminal', () => {
  const rows = formatAd(AD, MIN_COLS_ART - 1, 30);
  assert.equal(rows.length, 1, 'narrow terminal never receives broken art');
  assert.ok(visible(rows[0]).includes('TERABYTE'));
  assert.ok(visible(rows[0]).includes('sponsored'));
});

test('ascii_panel: degrades on a short terminal too', () => {
  const rows = formatAd(AD, 100, 10);
  assert.equal(rows.length, 1, 'a 10-row terminal must not lose a fifth of its screen');
});

test('ascii_panel: art is clamped to the terminal width, escapes not counted', () => {
  const wide = {
    format: 'ascii_panel',
    render: { cta: 'x', color: 'cyan', art_lines: [[{ t: 'W'.repeat(200), fg: 'red' }]] },
  };
  const rows = formatAd(wide, 70, 30);
  assert.ok(displayWidth(visible(rows[0])) <= 69, 'clamped to cols-1 by visible width');
});

test('ascii_panel: injected escapes in span text never reach the terminal', () => {
  const evil = {
    format: 'ascii_panel',
    render: {
      cta: 'x',
      color: 'cyan',
      art_lines: [[
        { t: 'safe', fg: 'green' },
        { t: '\x1b[2J\x1b[999;999H', fg: 'red' },
        { t: '\x1b]8;;http://evil\x07click', fg: 'red' },
      ]],
    },
  };
  const rows = formatAd(evil, 100, 30);
  const joined = rows.join('');
  assert.ok(joined.includes('safe'), 'the legitimate span still renders');
  assert.ok(!joined.includes('[2J'), 'clear-screen never emitted');
  assert.ok(!joined.includes('999;999H'), 'cursor move never emitted');
  assert.ok(!joined.includes(']8;;'), 'OSC hyperlink never emitted');
  assert.ok(!/\x1b(?!\[[0-9;]*m)/.test(joined), 'the ONLY escapes present are SGR');
});

test('ascii_panel: renders and clears exactly the rows it drew', () => {
  const { stream, writes } = fakeTty({ columns: 100, rows: 30 });
  const renderer = new LineRenderer(stream);
  const rows = formatAd(AD, 100, 30);

  assert.ok(renderer.render(rows), 'drawn on a TTY');
  assert.equal(renderer.activeHeight, 5);
  assert.ok(writes[0].includes('\x1b[26;1H'), 'the panel top lands 5 up from the bottom');

  renderer.clear();
  const cleared = writes[1];
  for (const row of [26, 27, 28, 29, 30]) {
    assert.ok(cleared.includes(`\x1b[${row};1H\x1b[2K`), `row ${row} erased`);
  }
  assert.equal(renderer.activeHeight, 0);
});

test('ascii_panel: the row ceiling holds even if a pack lies about its size', () => {
  const { stream } = fakeTty({ columns: 100, rows: 30 });
  const renderer = new LineRenderer(stream);
  const tooMany = Array.from({ length: 40 }, (_, i) => `row ${i}`);
  renderer.render(tooMany);
  assert.ok(renderer.activeHeight <= MAX_ROWS_ART + 2, `never more than ${MAX_ROWS_ART + 2} rows (art ceiling + panel borders)`);
});

test('rich_panel: the box closes — top and bottom borders both fit the ceiling', () => {
  const ad = {
    format: 'rich_panel',
    render: { lines: ['one', 'two', 'three'], cta: 'mesh.io/x', color: 'cyan', emoji: '🎮' },
  };
  const rows = formatAd(ad, 100, 30);
  assert.ok(rows.length <= 5, 'fits the text-format ceiling');
  assert.ok(rows[rows.length - 1].includes('└'), 'bottom border is never truncated away');
});

test('rich_panel: emoji no longer misaligns the border', () => {
  const ad = {
    format: 'rich_panel',
    render: { lines: ['🎮 gamer week'], cta: 'mesh.io/x', color: 'cyan' },
  };
  const rows = formatAd(ad, 100, 30).map(visible);
  const widths = rows.map(displayWidth);
  assert.equal(new Set(widths).size, 1, `every box row must be the same width, got ${widths}`);
});

/* ── entrance reveal ──────────────────────────────────────────────────────
 * Frames are derived from the already-signed spans, so animating must not
 * change what a creative carries, and must never show art without disclosure.
 */

test('reveal: frames grow monotonically and end exactly at the static render', () => {
  const frames = revealFrames(AD, 100, 30);
  assert.ok(frames.length > 1, 'ascii_panel animates');

  const widths = frames.map((f) => displayWidth(visible(f[0])));
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] >= widths[i - 1], `frame ${i} must not shrink (${widths})`);
  }
  assert.deepEqual(
    frames[frames.length - 1],
    formatAd(AD, 100, 30),
    'the last frame is byte-identical to the static render',
  );
});

test('reveal: the sponsored row is complete in EVERY frame', () => {
  for (const [i, frame] of revealFrames(AD, 100, 30).entries()) {
    const last = visible(frame[frame.length - 2]); // bottom border is the true last row
    assert.ok(last.includes('sponsored'), `frame ${i} lost the sponsored label`);
    assert.ok(last.includes('meshad pause'), `frame ${i} lost the pause hint`);
  }
});

test('reveal: colour survives partial frames — no half-written escape', () => {
  for (const [i, frame] of revealFrames(AD, 100, 30).entries()) {
    for (const row of frame.slice(0, -1)) {
      if (row === '') continue;
      assert.ok(row.endsWith('\x1b[0m'), `frame ${i} row does not reset`);
      assert.ok(!/\x1b(?!\[[0-9;]*m)/.test(row), `frame ${i} emitted a non-SGR escape`);
    }
  }
});

test('reveal: formats that cannot animate return a single frame', () => {
  const textAd = { format: 'text_line', render: { text: 'plain', cta: 'x', color: 'dim' } };
  assert.equal(revealFrames(textAd, 100, 30).length, 1, 'text_line does not animate');
  assert.equal(revealFrames(AD, 40, 30).length, 1, 'degraded art does not animate');
});

/* ── animated creatives: timeline + animator ──────────────────────────────
 * Animation multiplies the number of distinct screen states an ad can produce.
 * Every one of them has to satisfy the same invariants as the static render.
 */

const ANIMATED = {
  format: 'ascii_panel',
  render: {
    cta: 'mesh.io/tb',
    color: 'cyan',
    transition: 'wipe',
    loop: true,
    frames: [
      { art_lines: [[{ t: ' MÊS GAMER ', fg: 'bright_white', bg: 'magenta', bold: true }, { t: ' 65% OFF', fg: 'bright_yellow', bold: true }]], hold_ms: 900 },
      { art_lines: [[{ t: ' FRETE GRÁTIS ', fg: 'black', bg: 'bright_green', bold: true }, { t: ' Sul e Sudeste', fg: 'bright_white' }]], hold_ms: 900 },
    ],
  },
};

test('timeline: the sponsored row is complete in EVERY step, transitions included', () => {
  const { steps } = buildTimeline(ANIMATED, 100, 30);
  assert.ok(steps.length > 2, 'wipe produces transition sub-steps');
  for (const [i, step] of steps.entries()) {
    const last = visible(step.lines[step.lines.length - 2]); // bottom border is the true last row
    assert.ok(last.includes('sponsored'), `step ${i} lost the sponsored label`);
    assert.ok(last.includes('meshad pause'), `step ${i} lost the pause hint`);
  }
});

test('timeline: no step emits a non-SGR escape or leaves a style unreset', () => {
  for (const transition of ['cut', 'wipe', 'typewriter']) {
    const ad = { ...ANIMATED, render: { ...ANIMATED.render, transition } };
    for (const [i, step] of buildTimeline(ad, 100, 30).steps.entries()) {
      for (const row of step.lines.slice(0, -1)) {
        if (row === '') continue;
        assert.ok(!/\x1b(?!\[[0-9;]*m)/.test(row), `${transition} step ${i}: non-SGR escape`);
        assert.ok(row.endsWith('\x1b[0m'), `${transition} step ${i}: style not reset`);
      }
    }
  }
});

test('timeline: every step has the same height, so clear() erases everything', () => {
  const { steps } = buildTimeline(ANIMATED, 100, 30);
  const heights = new Set(steps.map((s) => s.lines.length));
  assert.equal(heights.size, 1, `all steps must be the same height, got ${[...heights]}`);
});

test('timeline: no step exceeds the terminal width', () => {
  const { steps } = buildTimeline(ANIMATED, 70, 30);
  for (const [i, step] of steps.entries()) {
    for (const row of step.lines) {
      assert.ok(displayWidth(visible(row)) <= 69, `step ${i} overflows the terminal`);
    }
  }
});

test('timeline: a static creative yields exactly one step and never loops', () => {
  const { steps, loop } = buildTimeline(AD, 100, 30);
  assert.equal(steps.length, 1);
  assert.equal(loop, false);
  assert.deepEqual(steps[0].lines, formatAd(AD, 100, 30));
});

test('timeline: art that degraded to one line does not animate', () => {
  const { steps, loop } = buildTimeline(ANIMATED, 40, 30);
  assert.equal(steps.length, 1, 'a narrow terminal gets the static fallback');
  assert.equal(loop, false);
});

test('animator: stop halts playback immediately and erases the drawn rows', () => {
  const { stream, writes } = fakeTty({ columns: 100, rows: 30 });
  const renderer = new LineRenderer(stream);

  const pending = [];
  const fakeSetTimeout = (fn, ms) => { pending.push({ fn, ms }); return { id: pending.length }; };
  const fakeClearTimeout = () => {};

  const animator = new Animator(renderer, { setTimeoutFn: fakeSetTimeout, clearTimeoutFn: fakeClearTimeout });
  assert.ok(animator.play(buildTimeline(ANIMATED, 100, 30)), 'first frame drawn');
  const drawnBefore = writes.length;

  animator.stop();
  // Anything still queued must become a no-op.
  pending.forEach((p) => p.fn());
  assert.equal(writes.length, drawnBefore + 1, 'only the clear was written after stop');

  animator.stop(); // idempotent
  assert.equal(renderer.activeHeight, 0);
});

test('animator: refuses to schedule anything when there is no TTY', () => {
  const stream = new Writable({ write(_c, _e, cb) { cb(); } });
  stream.isTTY = false;
  const animator = new Animator(new LineRenderer(stream));
  assert.equal(animator.play(buildTimeline(ANIMATED, 100, 30)), false, 'fail-closed without a TTY');
});

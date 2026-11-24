'use strict';

/** meshad play engines: seeded determinism, replay, and the Termo share string. */

const { test } = require('node:test');
const assert = require('node:assert');

const { utcDate, seedFor, makeRng } = require('../src/play/rng');
const runner = require('../src/play/runner');
const termo = require('../src/play/termo');

test('seed: same date + game → same seed; a different day or game differs; UTC rollover', () => {
  assert.equal(seedFor('2026-11-24', 'runner'), seedFor('2026-11-24', 'runner'));
  assert.notEqual(seedFor('2026-11-24', 'runner'), seedFor('2026-11-25', 'runner'));
  assert.notEqual(seedFor('2026-11-24', 'runner'), seedFor('2026-11-24', 'termo'));
  // 23:59:59 UTC and 00:00:00 UTC are different days, whatever the local zone says.
  assert.equal(utcDate(Date.UTC(2026, 10, 24, 23, 59, 59)), '2026-11-24');
  assert.equal(utcDate(Date.UTC(2026, 10, 25, 0, 0, 0)), '2026-11-25');
});

test('rng: same seed → same sequence', () => {
  const a = makeRng(42), b = makeRng(42);
  assert.deepEqual([a.next(), a.next(), a.int(100)], [b.next(), b.next(), b.int(100)]);
});

/** A bot that jumps when an obstacle is `lead` steps ahead. Returns the jump ticks it chose. */
function botInputs(seed, lead, maxTicks) {
  const s = runner.create(seed);
  const jumps = [];
  while (s.alive && s.tick < maxTicks) {
    const sp = Math.min(2, 1 + Math.floor(s.tick / 400));
    const near = s.obstacles.find((o) => o.x + o.w > runner.DINO_X && o.x - runner.DINO_X <= lead * sp);
    const jump = !!near && s.jumpT < 0;
    if (jump) jumps.push(s.tick);
    runner.step(s, jump);
  }
  return jumps;
}

test('runner: same seed + same inputs → identical result; different seed → different course', () => {
  const seed = seedFor('2026-11-24', 'runner');
  const jumps = [20, 45, 90];
  assert.deepEqual(runner.simulate(seed, jumps), runner.simulate(seed, jumps));
  const other = runner.simulate(seedFor('2026-11-25', 'runner'), jumps, 60);
  const same = runner.simulate(seed, jumps, 60);
  assert.notDeepEqual(other.obstacles, same.obstacles);
});

test('runner: no input dies on the first obstacle; the pinned score for 2026-11-24 is stable', () => {
  const r = runner.simulate(seedFor('2026-11-24', 'runner'), []);
  assert.equal(r.alive, false);
  assert.equal(r.score, 67); // pins the daily course: changing the RNG/geometry is a breaking change
});

test('runner: every daily course is clearable (a timed bot survives 3000 ticks on 30 seeds)', () => {
  for (let d = 1; d <= 30; d++) {
    const seed = seedFor(`2026-11-${String(d).padStart(2, '0')}`, 'runner');
    const jumps = botInputs(seed, 4, 3000);
    const r = runner.simulate(seed, jumps, 3000);
    assert.equal(r.alive, true, `day ${d} had an unclearable obstacle`);
    // …and replaying the recorded inputs reproduces the run exactly.
    assert.deepEqual(runner.simulate(seed, jumps, 3000), r);
  }
});

test('runner: a jump is ignored while airborne and the dino lands', () => {
  const s = runner.create(1);
  runner.step(s, true);
  const peak = [];
  for (let i = 0; i < runner.ARC.length; i++) { peak.push(runner.dinoHeight(s)); runner.step(s, true); }
  assert.ok(Math.max(...peak) >= 3);
  assert.equal(runner.dinoHeight(s) <= 3, true);
});

test('termo: word list is 5 lowercase a-z letters, unique; daily word is stable and in the list', () => {
  for (const w of termo.WORDS) assert.match(w, /^[a-z]{5}$/);
  assert.equal(new Set(termo.WORDS).size, termo.WORDS.length);
  assert.equal(termo.dailyWord('2026-11-24'), termo.dailyWord('2026-11-24'));
  assert.ok(termo.WORDS.includes(termo.dailyWord('2026-11-24')));
  assert.equal(termo.dailyWord('2026-11-24'), 'cargo'); // pins the list order + seed derivation
});

test('termo: repeated letters are credited only as often as they occur in the answer', () => {
  assert.deepEqual(termo.scoreGuess('array', 'cargo'), ['Y', 'B', 'G', 'B', 'B']);
  assert.equal(termo.scoreGuess('error', 'array').join(''), 'BGGBB'); // both r's sit exactly where array has them
  assert.equal(termo.scoreGuess('rrrrr', 'array').join(''), 'BGGBB'); // surplus r's get nothing
  assert.deepEqual(termo.scoreGuess('llama', 'hello'), ['Y', 'Y', 'B', 'B', 'B']);
  assert.deepEqual(termo.scoreGuess('cargo', 'cargo'), ['G', 'G', 'G', 'G', 'G']);
});

test('termo: the share string for a known replay is stable and spoiler-free', () => {
  const state = termo.replay('2026-11-24', ['array', 'cache', 'cargo']);
  assert.equal(state.won, true);
  assert.equal(
    termo.shareString(state),
    'Termo Dev 2026-11-24 3/6\n🟨⬛🟩⬛⬛\n🟩🟩⬛⬛⬛\n🟩🟩🟩🟩🟩',
  );
  const grid = termo.shareString(state).split('\n').slice(1).join('');
  assert.doesNotMatch(grid, /[a-z]/i, 'the grid carries no letters');
  assert.doesNotMatch(termo.shareString(state), /meshad\.io/, 'no link in the share string');
});

test('termo: losing prints X/6; illegal guesses and play-after-over are ignored', () => {
  const miss = ['array', 'cache', 'class', 'clone', 'cloud', 'codec'];
  const lost = termo.replay('2026-11-24', [...miss, 'cargo']);
  assert.equal(lost.won, false);
  assert.equal(lost.guesses.length, 6);
  assert.match(termo.shareString(lost), /^Termo Dev 2026-11-24 X\/6\n/);
  const s = termo.create('2026-11-24');
  assert.equal(termo.guess(s, 'abc'), false);
  assert.equal(termo.guess(s, 'ARRAY'), false);
  assert.equal(s.guesses.length, 0);
});

'use strict';

/**
 * Termo Dev — a daily five-letter developer-vocabulary word game (Wordle-style,
 * turn based). Pure: the answer comes from the UTC date seed, scoring and the
 * share grid are functions of (answer, guesses). No dictionary check — any five
 * letters a-z is a legal guess; the answer list is the only vocabulary.
 */

const { seedFor, makeRng } = require('./rng');

const WORD_LEN = 5;
const MAX_GUESSES = 6;

// Five letters, a-z only, unique. Append-only: reordering or removing a word
// changes which word every past/future date maps to (the test pins the order).
const WORDS = [
  'agent', 'array', 'async', 'await', 'babel', 'bench', 'build', 'bytes', 'cache', 'cargo',
  'chain', 'check', 'class', 'clone', 'cloud', 'codec', 'color', 'const', 'crash', 'crate',
  'debug', 'delta', 'drone', 'embed', 'enums', 'error', 'event', 'fetch', 'fiber', 'field',
  'files', 'flags', 'float', 'forks', 'frame', 'graph', 'batch', 'heaps', 'hooks', 'index',
  'infra', 'input', 'items', 'lexer', 'lints', 'locks', 'logic', 'login', 'loops', 'macro',
  'merge', 'mocks', 'model', 'mutex', 'nodes', 'parse', 'patch', 'pipes', 'pixel', 'plugs',
  'pools', 'ports', 'print', 'proxy', 'prune', 'query', 'queue', 'regex', 'retry', 'route',
  'rules', 'scope', 'shard', 'shell', 'slice', 'spawn', 'split', 'stack', 'state', 'store',
  'stubs', 'super', 'swarm', 'table', 'tasks', 'tests', 'token', 'trait', 'tuple', 'types',
  'union', 'users', 'utils', 'valid', 'value', 'yield', 'zones',
];

/** The word of the day for a UTC date (YYYY-MM-DD). */
function dailyWord(date) {
  return WORDS[makeRng(seedFor(date, 'termo')).int(WORDS.length)];
}

/**
 * Score a guess against the answer, standard Wordle two-pass rules (repeated
 * letters are only credited as often as they occur in the answer).
 * @returns {Array<'G'|'Y'|'B'>} G = right place, Y = elsewhere, B = absent
 */
function scoreGuess(guess, answer) {
  const marks = Array(WORD_LEN).fill('B');
  const left = {};
  for (let i = 0; i < WORD_LEN; i++) {
    if (guess[i] === answer[i]) marks[i] = 'G';
    else left[answer[i]] = (left[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < WORD_LEN; i++) {
    if (marks[i] === 'B' && left[guess[i]] > 0) {
      marks[i] = 'Y';
      left[guess[i]] -= 1;
    }
  }
  return marks;
}

function isLegalGuess(word) {
  return typeof word === 'string' && /^[a-z]{5}$/.test(word);
}

/** Fresh game for a date. */
function create(date) {
  return { date, answer: dailyWord(date), guesses: [], marks: [], won: false, over: false };
}

/** Submit a guess. Returns false (state untouched) when illegal or the game is over. */
function guess(state, word) {
  if (state.over || !isLegalGuess(word)) return false;
  const marks = scoreGuess(word, state.answer);
  state.guesses.push(word);
  state.marks.push(marks);
  if (marks.every((m) => m === 'G')) {
    state.won = true;
    state.over = true;
  } else if (state.guesses.length >= MAX_GUESSES) {
    state.over = true;
  }
  return true;
}

/** Replay a list of guesses from scratch — the pure function behind the share test. */
function replay(date, guesses) {
  const state = create(date);
  for (const g of guesses) guess(state, g);
  return state;
}

/** Leaderboard score: fewer guesses is better. 6 for a first-try win … 1 for the last guess; a loss scores 0. */
function score(state) {
  return state.won ? MAX_GUESSES + 1 - state.guesses.length : 0;
}

const EMOJI = { G: '🟩', Y: '🟨', B: '⬛' };

/** Wordle-style spoiler-free grid: score line + one emoji row per guess. No letters. */
function shareString(state) {
  const score = state.won ? state.guesses.length : 'X';
  const rows = state.marks.map((m) => m.map((x) => EMOJI[x]).join(''));
  return [`Termo Dev ${state.date} ${score}/${MAX_GUESSES}`, ...rows].join('\n');
}

module.exports = { WORD_LEN, MAX_GUESSES, WORDS, dailyWord, scoreGuess, isLegalGuess, create, guess, replay, score, shareString };

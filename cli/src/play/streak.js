'use strict';

/**
 * Daily streaks and personal bests — LOCAL ONLY. One small file per config dir
 * (play-streaks.json, 0600, atomic write). Nothing here is ever sent anywhere:
 * the leaderboard replays (seed, inputs) on its own and knows nothing of streaks.
 *
 * A day counts when a game is finished that day (Termo: finished AND won).
 * Dates are the same UTC YYYY-MM-DD seeds the games use.
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../config');

const FILE = 'play-streaks.json';
const GAME_KEYS = ['runner', 'termo', 'snake', 'flappy', 'blocks', 'slide', 'chess'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INT = 1_000_000;

const emptyEntry = () => ({ best: 0, streak: 0, best_streak: 0, last_date: null, played: 0 });
const int = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_INT) : 0);

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return emptyEntry();
  return {
    best: int(raw.best),
    streak: int(raw.streak),
    best_streak: int(raw.best_streak),
    last_date: typeof raw.last_date === 'string' && DATE_RE.test(raw.last_date) ? raw.last_date : null,
    played: int(raw.played),
  };
}

/** One entry per game in GAME_KEYS — always every key, garbage in the file reads as zeros. */
function load(dir) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')); } catch { /* none yet */ }
  return Object.fromEntries(GAME_KEYS.map((g) => [g, cleanEntry(raw && raw[g])]));
}

function prevDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** The streak to show today: a streak whose last day was before yesterday has lapsed. */
function liveStreak(entry, date) {
  if (!entry || !entry.last_date || !DATE_RE.test(date)) return 0;
  return entry.last_date === date || entry.last_date === prevDay(date) ? entry.streak : 0;
}

/** Pure update of one entry for a finished game on `date`. */
function apply(entry, date, { score = 0, won = true } = {}) {
  const e = { ...entry, played: Math.min(MAX_INT, entry.played + 1), best: Math.max(entry.best, int(score)) };
  if (!won) e.streak = 0;
  else if (e.last_date === date) { /* already counted today */ } else if (e.last_date === prevDay(date)) e.streak += 1;
  else e.streak = 1;
  if (won || e.last_date !== date) e.last_date = date;
  e.best_streak = Math.max(e.best_streak, e.streak);
  return e;
}

/** Record a finished game and persist. Returns the updated entry; never throws (a write failure keeps the in-memory result). */
function record(dir, game, date, result) {
  if (!GAME_KEYS.includes(game) || !DATE_RE.test(date)) return emptyEntry();
  const all = load(dir);
  all[game] = apply(all[game], date, result);
  try { writeFileAtomic(dir, FILE, JSON.stringify(all, null, 2) + '\n'); } catch { /* best effort */ }
  return all[game];
}

module.exports = { FILE, GAME_KEYS, load, record, apply, liveStreak, prevDay, emptyEntry };

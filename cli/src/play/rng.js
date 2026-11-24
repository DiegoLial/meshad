'use strict';

/**
 * Deterministic daily seed + PRNG for `meshad play`. Pure: same date + game id
 * → same seed → same sequence, on every machine, forever. No Math.random,
 * no clock reads (callers pass the date in).
 */

const crypto = require('node:crypto');

/** UTC calendar day, YYYY-MM-DD — the daily rollover is the same for everyone. */
function utcDate(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** 32-bit seed from "<date>:<gameId>". */
function seedFor(date, gameId) {
  return crypto.createHash('sha256').update(`${date}:${gameId}`).digest().readUInt32BE(0);
}

/** mulberry32 — tiny, fast, good enough for obstacle gaps and a word pick. */
function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** Integer in [0, n). */
    int: (n) => Math.floor(next() * n),
    /** Serializable position, so a paused game can be inspected/cloned. */
    get state() { return a; },
  };
}

module.exports = { utcDate, seedFor, makeRng };

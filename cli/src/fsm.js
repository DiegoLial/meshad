'use strict';

/**
 * Idle state machine — pure and clock-injectable. No I/O, no timers of its own.
 *
 *   idle ──idleStart──► waiting ──tick(≥ minWaitMs, cap ok)──► displaying ──idleEnd──► idle
 *
 * Rules (CONTRACT.md invariants):
 *  - display only after minWaitMs of continuous wait;
 *  - local frequency cap: max `capPerHour` impressions per sliding window
 *    (history of impression timestamps is passed in / read back for persistence);
 *  - impression only if the ad was displayed ≥ 2000ms;
 *  - idleEnd has absolute priority and is valid from any state.
 *
 * The caller drives it with timestamps and performs the returned actions:
 *   {type:'display'} · {type:'clear'} · {type:'impression', displayed_ms} ·
 *   {type:'idle_end', duration_ms}
 */

const HOUR_MS = 3600000;
const MIN_DISPLAY_FOR_IMPRESSION_MS = 2000;

class IdleStateMachine {
  constructor({ minWaitMs = 8000, capPerHour = 6, capWindowMs = HOUR_MS, history = [] } = {}) {
    this.minWaitMs = minWaitMs;
    this.capPerHour = capPerHour;
    this.capWindowMs = capWindowMs;
    /** Timestamps (epoch ms) of recorded impressions — the persisted sliding window. */
    this.history = Array.isArray(history) ? history.slice() : [];
    this.state = 'idle';
    this.idleStartAt = null;
    this.displayStartAt = null;
  }

  /** Impressions still inside the sliding window at time `now`. */
  _prune(now) {
    this.history = this.history.filter((t) => now - t < this.capWindowMs);
    return this.history.length;
  }

  canDisplay(now) {
    return this._prune(now) < this.capPerHour;
  }

  /** The agent went quiet. */
  idleStart(now) {
    if (this.state !== 'idle') return [];
    this.state = 'waiting';
    this.idleStartAt = now;
    this.displayStartAt = null;
    return [];
  }

  /** Periodic clock tick while waiting. May promote waiting → displaying. */
  tick(now) {
    if (this.state !== 'waiting') return [];
    if (now - this.idleStartAt < this.minWaitMs) return [];
    if (!this.canDisplay(now)) return [];
    this.state = 'displaying';
    this.displayStartAt = now;
    return [{ type: 'display' }];
  }

  /**
   * Output resumed / process exited. Absolute priority: valid from any state.
   * Returns actions in execution order — 'clear' always first.
   */
  idleEnd(now) {
    const actions = [];
    if (this.state === 'idle') return actions;

    const idleDuration = Math.max(0, now - this.idleStartAt);

    if (this.state === 'displaying') {
      actions.push({ type: 'clear' });
      const displayedMs = Math.max(0, now - this.displayStartAt);
      if (displayedMs >= MIN_DISPLAY_FOR_IMPRESSION_MS) {
        this.history.push(now);
        this._prune(now);
        actions.push({ type: 'impression', displayed_ms: displayedMs });
      }
    }

    actions.push({ type: 'idle_end', duration_ms: idleDuration });
    this.state = 'idle';
    this.idleStartAt = null;
    this.displayStartAt = null;
    return actions;
  }
}

module.exports = { IdleStateMachine, MIN_DISPLAY_FOR_IMPRESSION_MS, HOUR_MS };

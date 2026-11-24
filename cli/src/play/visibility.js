'use strict';

/**
 * "Was the game really on screen?" — the billing gate for the `--play` split.
 * Pure: the clock, the render signal and the tmux answer are all passed in.
 *
 * Visible now ⇔ BOTH
 *   (a) play says it is rendering: a fresh play-render.json (TTY + alternate
 *       screen up + not frozen + still beating), coming from OUR split's pane;
 *   (b) tmux says the split's window is the active one of an attached session
 *       (and the split is not hidden behind a zoomed sibling pane).
 * Pane focus (pane_active) is deliberately NOT required: the split sits beside
 * the agent and is visible without stealing the keyboard. If tmux cannot be
 * asked, nothing is visible.
 */

const { RENDER_STALE_MS } = require('./bridge');
const { MIN_DISPLAY_FOR_IMPRESSION_MS } = require('../fsm');

/**
 * @param {{render: ?{rendering:boolean, ts:number, pane:?string}, info: ?object, now: number, pane: string}} a
 *   `info` is tmux.paneInfo() (null = unavailable).
 */
function isVisible({ render, info, now, pane }) {
  if (!render || render.rendering !== true) return false;
  if (!(now - render.ts <= RENDER_STALE_MS) || render.ts - now > RENDER_STALE_MS) return false;
  if (render.pane && render.pane !== pane) return false; // some other `meshad play`
  if (!info || info.dead) return false;
  if (!info.windowActive || !(info.attached > 0)) return false;
  if (info.zoomed && !info.paneActive) return false; // zoom hides every pane but the active one
  return true;
}

/**
 * Accumulates visible time from periodic samples. A sample only credits the
 * interval since the previous one when BOTH were visible, so a gap never gets
 * billed. The impression needs one continuous streak ≥ floorMs; the reported
 * duration is the total visible time (never the time since the split opened).
 */
class VisibilityTracker {
  constructor({ floorMs = MIN_DISPLAY_FOR_IMPRESSION_MS } = {}) {
    this.floorMs = floorMs;
    this.totalMs = 0;
    this.bestStreakMs = 0;
    this._streakMs = 0;
    this._lastVisibleAt = null; // timestamp of the previous sample if it was visible
  }

  sample(now, visible) {
    if (visible) {
      if (this._lastVisibleAt !== null && now > this._lastVisibleAt) {
        const d = now - this._lastVisibleAt;
        this.totalMs += d;
        this._streakMs += d;
        this.bestStreakMs = Math.max(this.bestStreakMs, this._streakMs);
      }
      this._lastVisibleAt = now;
    } else {
      this._lastVisibleAt = null;
      this._streakMs = 0;
    }
  }

  /** Billable duration: total visible ms if one continuous streak reached the floor, else 0. */
  billableMs() {
    return this.bestStreakMs >= this.floorMs ? this.totalMs : 0;
  }
}

module.exports = { isVisible, VisibilityTracker };

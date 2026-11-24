'use strict';

/**
 * run ⇄ play bridge — a tiny state file in the config dir. No sockets, no
 * network, no stdin sharing: `meshad run` writes, `meshad play` polls.
 *
 *   <configDir>/play-state.json   { "state": "waiting" | "idle", "ts": <epoch ms> }
 *
 * That is the whole payload — never a prompt, a command or an ad id. Writes are
 * atomic (tmp + rename) so the reader never sees a torn file.
 *
 * Semantics for the reader (`gateFor`):
 *   waiting (fresh)  → the agent is thinking: play runs
 *   idle             → the agent is producing output: play freezes
 *   no file / stale / garbage → nobody is driving: free-play, play runs
 * `waiting` is heartbeated by run; if the beat stops (run crashed) it goes stale
 * and play falls back to free-play instead of staying "waiting" forever.
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../config');

const STATE_FILE = 'play-state.json';
const RENDER_FILE = 'play-render.json';
const STATES = ['waiting', 'idle'];
/** run re-writes `waiting` this often… */
const HEARTBEAT_MS = 5000;
/** …and a `waiting` older than this is treated as a dead writer. */
const STALE_MS = 15000;

/** Write the state. Only 'waiting' | 'idle' are representable. */
function writeState(dir, state, now = Date.now()) {
  if (!STATES.includes(state)) throw new Error(`invalid play state "${state}"`);
  writeFileAtomic(dir, STATE_FILE, JSON.stringify({ state, ts: now }) + '\n');
}

/** Remove the file (run exited) so a later `meshad play` is plain free-play. */
function clearState(dir) {
  try { fs.unlinkSync(path.join(dir, STATE_FILE)); } catch { /* already gone */ }
}

/** Parsed {state, ts} or null for a missing / malformed / out-of-contract file. */
function readState(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
    if (!v || !STATES.includes(v.state) || !Number.isFinite(v.ts)) return null;
    return { state: v.state, ts: v.ts };
  } catch {
    return null;
  }
}

/**
 * How play relates to the agent right now:
 *   'waiting' — fresh waiting beat, the agent is thinking
 *   'idle'    — the agent is producing output
 *   'free'    — no usable signal (no file, garbage, or a dead writer's stale beat)
 */
function modeOf(read, now = Date.now()) {
  if (!read) return 'free';
  if (read.state === 'idle') return 'idle';
  return now - read.ts <= STALE_MS ? 'waiting' : 'free';
}

/**
 * Should the game be running? `override` is the player's explicit "keep playing"
 * (free-play): it unfreezes an idle agent but never bills anything.
 * @returns {'run'|'frozen'}
 */
function gateFor(read, now = Date.now(), override = false) {
  if (override) return 'run';
  return modeOf(read, now) === 'idle' ? 'frozen' : 'run';
}

/** play re-writes its render signal this often… */
const RENDER_BEAT_MS = 1000;
/** …and a signal older than this means play stopped drawing (frozen, hung, killed). */
const RENDER_STALE_MS = 2500;

/**
 * play → run: "I am drawing right now". A second file, so run's heartbeat on
 * play-state.json never overwrites it. {rendering:true, ts[, pane]} — `pane` is
 * the tmux pane id play runs in ($TMUX_PANE), only so run can tell its own split
 * from some other `meshad play`. Never an ad id, prompt or command. Local only.
 */
function writeRender(dir, now = Date.now(), pane = null) {
  const v = { rendering: true, ts: now };
  if (typeof pane === 'string' && /^%\d+$/.test(pane)) v.pane = pane;
  writeFileAtomic(dir, RENDER_FILE, JSON.stringify(v) + '\n');
}

function clearRender(dir) {
  try { fs.unlinkSync(path.join(dir, RENDER_FILE)); } catch { /* already gone */ }
}

/** Parsed {rendering:true, ts, pane|null} or null for missing / malformed / out-of-contract. */
function readRender(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, RENDER_FILE), 'utf8'));
    if (!v || v.rendering !== true || !Number.isFinite(v.ts)) return null;
    return { rendering: true, ts: v.ts, pane: typeof v.pane === 'string' ? v.pane : null };
  } catch {
    return null;
  }
}

module.exports = { RENDER_FILE, RENDER_BEAT_MS, RENDER_STALE_MS, writeRender, clearRender, readRender, STATE_FILE, STATES, HEARTBEAT_MS, STALE_MS, writeState, clearState, readState, modeOf, gateFor };

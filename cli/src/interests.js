'use strict';

/**
 * Local-only interest declarations for the optional news panel.
 *
 * Interests live ONLY in <configDir>/interests.json (0600). They are never
 * uploaded, never put in telemetry, and never sent as a query parameter: the
 * client downloads one generic dev/AI feed (GET /v1/news/feed, no anon_id, no
 * interests) and filters it locally.
 *
 * Why `publisher_interests` is NOT wired to the server: that table is keyed by
 * account, there is no k>=50 aggregation in front of it, and nothing does
 * auction targeting with it yet. Sending interests there would link a declared
 * profile to an identity for no benefit. Local-only + a generic feed guarantees
 * zero interest leakage; revisit only together with k-anonymous aggregation and
 * real targeting.
 *
 * Everything is OFF by default: no consent, no topics, no news.
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./config');

const FILE = 'interests.json';
const NEWS_CACHE_FILE = 'news-cache.json';
const NEWS_READ_FILE = 'news-read.json'; // local read marks; see news-read.js

// Closed taxonomy — must stay identical to INTEREST_TAXONOMY in apps/api/src/news.js.
const TAXONOMY = Object.freeze([
  'lang:typescript', 'lang:python', 'lang:rust', 'lang:go', 'lang:javascript',
  'ai:agents', 'ai:llm',
  'topic:security', 'topic:systems', 'topic:devtools', 'topic:oss', 'topic:databases', 'topic:web',
  'topic:brasil',
]);

function defaultState() {
  return { enabled: false, consented_at: null, topics: [] };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();
  return {
    enabled: raw.enabled === true,
    consented_at: typeof raw.consented_at === 'string' ? raw.consented_at : null,
    topics: Array.isArray(raw.topics) ? [...new Set(raw.topics.filter((t) => TAXONOMY.includes(t)))] : [],
  };
}

function loadInterests(dir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')));
  } catch {
    return defaultState();
  }
}

function saveInterests(dir, state) {
  writeFileAtomic(dir, FILE, JSON.stringify(normalize(state), null, 2) + '\n');
}

/** Wipe everything (topics, consent, enabled flag) and drop the news cache and read marks. */
function clearInterests(dir) {
  saveInterests(dir, defaultState());
  for (const f of [NEWS_CACHE_FILE, NEWS_READ_FILE]) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* absent */ }
  }
}

/** News shows only with consent AND at least one topic AND (enabled OR --news). */
function isNewsActive(state, { flagNews } = {}) {
  return !!(state && state.consented_at && state.topics.length > 0 && (state.enabled || flagNews));
}

/** @returns {{ok:true, topics:string[]} | {ok:false, unknown:string[]}} */
function validateTopics(topics) {
  const list = Array.isArray(topics) ? topics : [];
  const unknown = list.filter((t) => !TAXONOMY.includes(t));
  return unknown.length ? { ok: false, unknown } : { ok: true, topics: [...new Set(list)] };
}

function addTopics(state, topics) {
  return { ...state, topics: [...new Set([...state.topics, ...topics])] };
}

function removeTopics(state, topics) {
  return { ...state, topics: state.topics.filter((t) => !topics.includes(t)) };
}

module.exports = {
  FILE, NEWS_CACHE_FILE, NEWS_READ_FILE, TAXONOMY, defaultState, loadInterests, saveInterests, clearInterests,
  isNewsActive, addTopics, removeTopics, validateTopics,
};

'use strict';

/**
 * Generic dev/AI headline feed + local cache (news-cache.json).
 *
 * GET /v1/news/feed carries NOTHING about the user: no anon_id, no api key, no
 * query string. Which headlines are shown is decided locally from the
 * interests in interests.json. Same shape as AdCache: stale-while-revalidate,
 * fail-closed ([]) on a cold offline start, atomic writes. Every item is
 * re-sanitized on the way in AND on the way out of the cache — a hand-edited
 * cache file can't smuggle control characters or tracking links onto the screen.
 */

const fs = require('node:fs');
const path = require('node:path');
const { meshFetch } = require('./net');
const { writeFileAtomic } = require('./config');
const { TAXONOMY, NEWS_CACHE_FILE: CACHE_FILE } = require('./interests');

const DEFAULT_TTL_S = 900;
const MAX_ITEMS = 50;
const MAX_TITLE = 140;
const MAX_SOURCE = 60;

const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|yclid|si)$/i;
const TRACKING_IN_HASH = /(^|[#&?])(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|yclid|si)=/i;

function cleanText(s, max) {
  return String(s ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[\s\S]?/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** https only, no credentials, no tracking params (rejected, not rewritten). Clean URL or null. */
function cleanUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  for (const k of u.searchParams.keys()) if (TRACKING_PARAM.test(k)) return null;
  if (TRACKING_IN_HASH.test(u.hash)) return null;
  return u.toString();
}

/** Optional publish time → ISO string, or null (unparseable / absurd values are dropped, never guessed). */
function cleanPublished(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) ? new Date(ms).toISOString() : null;
}

/** Raw feed item → safe item, or null. */
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = cleanUrl(raw.url);
  const title = cleanText(raw.title, MAX_TITLE);
  if (!url || !title) return null;
  const topics = Array.isArray(raw.topics) ? [...new Set(raw.topics.filter((t) => TAXONOMY.includes(t)))] : [];
  if (!topics.length) return null;
  const source = cleanText(raw.source, MAX_SOURCE) || new URL(url).hostname.replace(/^www\./, '');
  return { id: cleanText(raw.id, 40) || null, topic: topics[0], topics, title, url, source, published_at: cleanPublished(raw.published_at) };
}

function sanitizeItems(items) {
  return (Array.isArray(items) ? items : []).map(sanitizeItem).filter(Boolean).slice(0, MAX_ITEMS);
}

/** Items matching at least one declared topic, in feed order. */
function filterMatchingItems(items, topics) {
  if (!Array.isArray(items) || !Array.isArray(topics) || topics.length === 0) return [];
  return items.filter((it) => it && Array.isArray(it.topics) && it.topics.some((t) => topics.includes(t)));
}

class NewsCache {
  constructor({ dir, apiUrl, fetchImpl = meshFetch, now = Date.now, timeoutMs = 3000 }) {
    this.dir = dir;
    this.apiUrl = apiUrl;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  peek() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, CACHE_FILE), 'utf8'));
    } catch {
      return null;
    }
  }

  _write(data) {
    writeFileAtomic(this.dir, CACHE_FILE, JSON.stringify(data, null, 2) + '\n');
  }

  isFresh(cache = this.peek()) {
    if (!cache || !Array.isArray(cache.items)) return false;
    return this.now() < cache.fetched_at + cache.ttl_seconds * 1000;
  }

  /** Sanitized items: fresh cache, else stale-while-revalidate, else fetch, else []. */
  async getFeed() {
    const cache = this.peek();
    if (this.isFresh(cache)) return sanitizeItems(cache.items);

    const refresh = this._refresh();
    if (cache && Array.isArray(cache.items) && cache.items.length) {
      refresh.catch(() => {});
      return sanitizeItems(cache.items);
    }
    try {
      return await refresh;
    } catch {
      return [];
    }
  }

  /** Force a fetch now (the `r` key). Resolves to the fresh items, or null when offline/failed. */
  async refresh() {
    try { return await this._refresh(); } catch { return null; }
  }

  _refresh() {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      const res = await this.fetch(`${this.apiUrl}/v1/news/feed`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`GET /v1/news/feed → ${res.status}`);
      const body = await res.json();
      const items = sanitizeItems(body && body.items);
      const prev = this.peek();
      this._write({
        fetched_at: this.now(),
        ttl_seconds: Number(body && body.ttl_seconds) > 0 ? Number(body.ttl_seconds) : DEFAULT_TTL_S,
        items,
        rotation_cursor: prev && Number.isInteger(prev.rotation_cursor) ? prev.rotation_cursor : 0,
      });
      return items;
    })();
    return this._inflight.finally(() => { this._inflight = null; });
  }

  /** 1..count matching headlines, rotating through the matches via a persisted cursor. */
  nextHeadlines(items, topics, count = 2) {
    const matches = filterMatchingItems(items, topics);
    if (matches.length === 0) return [];
    const n = Math.min(Math.max(1, count), matches.length);
    const cache = this.peek() || {};
    const cursor = Number.isInteger(cache.rotation_cursor) && cache.rotation_cursor >= 0 ? cache.rotation_cursor : 0;
    const picked = [];
    for (let i = 0; i < n; i++) picked.push(matches[(cursor + i) % matches.length]);
    try {
      this._write({ ...cache, rotation_cursor: (cursor + n) % matches.length });
    } catch { /* the cursor is cosmetic */ }
    return picked;
  }
}

module.exports = { NewsCache, filterMatchingItems, sanitizeItem, sanitizeItems, cleanUrl, CACHE_FILE };

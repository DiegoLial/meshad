'use strict';

/**
 * Ad pack pre-fetch + local cache with MANDATORY Ed25519 verification.
 *
 * - Packs come from GET /v1/ads/pack and live in <configDir>/cache.json with
 *   their TTL; nothing on the render path ever touches the network.
 * - The signing public key comes from GET /v1/keys/public (DER-SPKI base64)
 *   and is cached in pubkey.json.
 * - The pack request declares `features=game`: this client verifies render.game
 *   (older ones would drop such ads, so the server leaves them out for them).
 * - Every ad is verified against the canonical JSON defined in CONTRACT.md:
 *   JSON.stringify of {ad_id, campaign_id, format, min_wait_ms,
 *   render:{text,lines,cta,color,emoji,art_lines,frames,transition,loop}} with
 *   keys in exactly that order. The last four are present only for ascii_panel,
 *   and frames/transition/loop only when the creative is animated.
 * - An ad with a bad signature is dropped silently; a persistent counter
 *   (invalid_dropped_total) surfaces it in `meshad status`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { meshFetch } = require('./net');
const { canonicalAdJson, verifyAd } = require('./signature');
const { writeFileAtomic } = require('./config');

const CACHE_FILE = 'cache.json';
const PUBKEY_FILE = 'pubkey.json';
/** Cached signing key is re-fetched once older than this. */
const PUBKEY_TTL_MS = 24 * 60 * 60 * 1000;

class AdCache {
  constructor({ dir, apiUrl, fetchImpl = meshFetch, now = Date.now, timeoutMs = 3000 }) {
    this.dir = dir;
    this.apiUrl = apiUrl;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  _read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  _write(name, data) {
    // Atomic: `meshad play` reads cache.json while `meshad run` rewrites it.
    writeFileAtomic(this.dir, name, JSON.stringify(data, null, 2) + '\n');
  }

  async _get(pathname) {
    const res = await this.fetch(`${this.apiUrl}${pathname}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}`);
    return res.json();
  }

  /** Signing key (base64 DER-SPKI), cached on disk and re-fetched after PUBKEY_TTL_MS. */
  async getPublicKey() {
    const cached = this._read(PUBKEY_FILE, null);
    if (
      cached &&
      cached.algorithm === 'ed25519' &&
      cached.public_key_b64 &&
      Number.isFinite(cached.fetched_at) &&
      this.now() - cached.fetched_at >= 0 &&
      this.now() - cached.fetched_at < PUBKEY_TTL_MS
    ) {
      return cached.public_key_b64;
    }
    const body = await this._get('/v1/keys/public');
    if (!body || body.algorithm !== 'ed25519' || !body.public_key_b64) {
      throw new Error('unexpected /v1/keys/public response');
    }
    this._write(PUBKEY_FILE, { algorithm: 'ed25519', public_key_b64: body.public_key_b64, fetched_at: this.now() });
    return body.public_key_b64;
  }

  /** Current cache contents (may be expired) — for `status`. */
  peek() {
    return this._read(CACHE_FILE, null);
  }

  /**
   * Rotate through the ranked pack: each wait shows the next ad, cycling.
   * The server already ranked the pack by the auction; cycling it spreads
   * impressions across every paying campaign instead of burning the same
   * top creative on the same person (each ad bills at its own price, so
   * the network earns either way and the viewer sees variety). The cursor
   * is persisted next to the cache and survives across invocations; it
   * resets naturally when a new pack replaces the file.
   */
  nextAd(ads) {
    if (!Array.isArray(ads) || ads.length === 0) return null;
    const cache = this.peek() || {};
    const cursor = Number.isInteger(cache.rotation_cursor) ? cache.rotation_cursor : 0;
    const ad = ads[cursor % ads.length];
    this._write(CACHE_FILE, { ...cache, rotation_cursor: (cursor + 1) % ads.length });
    return ad;
  }

  isFresh(cache = this.peek()) {
    if (!cache || !Array.isArray(cache.ads)) return false;
    return this.now() < cache.fetched_at + cache.ttl_seconds * 1000;
  }

  /**
   * Return verified ads, from cache when fresh, otherwise (re-)fetched.
   * Invalid signatures are dropped silently and counted. On any network
   * failure returns whatever the cache has ([] worst case) — fail-closed.
   */
  async getAds({ anonId, terminalType, max = 8 }) {
    const cache = this.peek();
    if (this.isFresh(cache)) return cache.ads;

    const refresh = this._refresh({ anonId, terminalType, max });

    // Stale-while-revalidate: an expired pack is still a pack of signed,
    // verified ads — showing one beats showing nothing while the refresh
    // crosses the network (two round trips on a bad day). The refreshed pack
    // is on disk for the next wait.
    if (cache && Array.isArray(cache.ads) && cache.ads.length) {
      refresh.catch(() => {});
      return cache.ads;
    }

    // Cold start (no cache at all): the network is the only source. One
    // retry absorbs the single dropped packet that would otherwise turn a
    // fresh install's first wait into "no ad shown".
    try {
      return await refresh;
    } catch {
      try {
        return await this._refresh({ anonId, terminalType, max });
      } catch {
        return [];
      }
    }
  }

  /** Fetch + verify + persist a new pack. Concurrent callers share one flight. */
  _refresh({ anonId, terminalType, max }) {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      const cache = this.peek();
      const q = new URLSearchParams({ anon_id: anonId, terminal_type: terminalType, max: String(max), features: 'game' });
      const [publicKey, pack] = await Promise.all([
        this.getPublicKey(),
        this._get(`/v1/ads/pack?${q}`),
      ]);
      const all = Array.isArray(pack.ads) ? pack.ads : [];
      const ads = all.filter((ad) => verifyAd(ad, publicKey));
      const dropped = all.length - ads.length;
      this._write(CACHE_FILE, {
        pack_id: pack.pack_id,
        fetched_at: this.now(),
        ttl_seconds: Number(pack.ttl_seconds) || 900,
        ads,
        invalid_dropped_total: ((cache && cache.invalid_dropped_total) || 0) + dropped,
      });
      return ads;
    })();
    return this._inflight.finally(() => {
      this._inflight = null;
    });
  }
}

module.exports = { AdCache, canonicalAdJson, verifyAd, CACHE_FILE, PUBKEY_FILE, PUBKEY_TTL_MS };

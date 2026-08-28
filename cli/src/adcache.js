'use strict';

/**
 * Ad pack pre-fetch + local cache with MANDATORY Ed25519 verification.
 *
 * - Packs come from GET /v1/ads/pack and live in <configDir>/cache.json with
 *   their TTL; nothing on the render path ever touches the network.
 * - The signing public key comes from GET /v1/keys/public (DER-SPKI base64)
 *   and is cached in pubkey.json.
 * - Every ad is verified against the canonical JSON defined in CONTRACT.md:
 *   JSON.stringify of {ad_id, campaign_id, format, min_wait_ms,
 *   render:{text,lines,cta,color,emoji,art_lines,frames,transition,loop}} with
 *   keys in exactly that order. The last four are present only for ascii_panel,
 *   and frames/transition/loop only when the creative is animated.
 * - An ad with a bad signature is dropped silently; a persistent counter
 *   (invalid_dropped_total) surfaces it in `meshad status`.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CACHE_FILE = 'cache.json';
const PUBKEY_FILE = 'pubkey.json';

/** Canonical JSON over the signed fields — key order is part of the contract. */
function canonicalAdJson(ad) {
  const render = ad.render || {};
  return JSON.stringify({
    ad_id: ad.ad_id,
    campaign_id: ad.campaign_id,
    format: ad.format,
    min_wait_ms: ad.min_wait_ms,
    render: {
      text: render.text,
      lines: render.lines,
      cta: render.cta,
      color: render.color,
      emoji: render.emoji ?? null,
      // Undefined for text formats (omitted by JSON.stringify, so their bytes
      // are unchanged); for ascii_panel the art is signed with the rest, and a
      // pack that tampers with a single span fails verification.
      art_lines: render.art_lines,
      frames: render.frames,
      transition: render.transition,
      loop: render.loop,
    },
  });
}

/** True iff ad.signature is a valid Ed25519 signature by publicKeyB64 (DER-SPKI). */
function verifyAd(ad, publicKeyB64) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.from(canonicalAdJson(ad), 'utf8'),
      key,
      Buffer.from(String(ad.signature || ''), 'base64')
    );
  } catch {
    return false;
  }
}

class AdCache {
  constructor({ dir, apiUrl, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 3000 }) {
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
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }

  async _get(pathname) {
    const res = await this.fetch(`${this.apiUrl}${pathname}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}`);
    return res.json();
  }

  /** Signing key (base64 DER-SPKI), cached on disk after first fetch. */
  async getPublicKey() {
    const cached = this._read(PUBKEY_FILE, null);
    if (cached && cached.public_key_b64) return cached.public_key_b64;
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
      const q = new URLSearchParams({ anon_id: anonId, terminal_type: terminalType, max: String(max) });
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

module.exports = { AdCache, canonicalAdJson, verifyAd, CACHE_FILE, PUBKEY_FILE };

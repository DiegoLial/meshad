'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AdCache } = require('../src/adcache');

test('nextAd cycles through the ranked pack and persists the cursor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-rot-'));
  const cache = new AdCache({ dir, apiUrl: 'http://unused' });
  const ads = [{ ad_id: 'a' }, { ad_id: 'b' }, { ad_id: 'c' }];

  const seen = [1, 2, 3, 4].map(() => cache.nextAd(ads).ad_id);
  assert.deepStrictEqual(seen, ['a', 'b', 'c', 'a']);

  // A fresh instance over the same dir continues where the last one stopped.
  const cache2 = new AdCache({ dir, apiUrl: 'http://unused' });
  assert.strictEqual(cache2.nextAd(ads).ad_id, 'b');

  assert.strictEqual(cache.nextAd([]), null);
  assert.strictEqual(cache.nextAd(null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getAds serves a stale pack instantly and refreshes in the background', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-swr-'));
  let fetches = 0;
  let releaseFetch;
  const gate = new Promise((r) => { releaseFetch = r; });
  const fetchImpl = async (url) => {
    fetches += 1;
    if (String(url).includes('/v1/keys/public')) {
      return { ok: true, json: async () => ({ algorithm: 'ed25519', public_key_b64: 'QQ==' }) };
    }
    await gate; // the refresh hangs on the network until released
    return { ok: true, json: async () => ({ pack_id: 'p2', ttl_seconds: 900, ads: [] }) };
  };
  let t = 1000000;
  const cache = new AdCache({ dir, apiUrl: 'http://unused', fetchImpl, now: () => t });

  // Seed an EXPIRED cache on disk with one ad.
  fs.writeFileSync(path.join(dir, 'cache.json'), JSON.stringify({
    pack_id: 'p1', fetched_at: 0, ttl_seconds: 1, ads: [{ ad_id: 'stale-ad' }],
  }));

  const ads = await cache.getAds({ anonId: 'x', terminalType: 'other' });
  assert.strictEqual(ads.length, 1, 'stale pack must be served instantly');
  assert.strictEqual(ads[0].ad_id, 'stale-ad');
  releaseFetch();
  await new Promise((r) => setTimeout(r, 20)); // let the background refresh land
  assert.ok(fetches >= 1, 'a background refresh must have been fired');
  fs.rmSync(dir, { recursive: true, force: true });
});

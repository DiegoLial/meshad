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

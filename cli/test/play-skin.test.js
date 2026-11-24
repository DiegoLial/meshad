'use strict';

/** Sponsored skin: play re-verifies the signature against the LOCAL pubkey before drawing. */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { canonicalAdJson } = require('../src/signature');
const skin = require('../src/play/skin');
const adcache = require('../src/adcache');
const { PlaySession } = require('../src/play/session');

const keys = crypto.generateKeyPairSync('ed25519');
const pubB64 = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function signedAd(render = {}, extra = {}) {
  const ad = {
    ad_id: 'ad_skin1', campaign_id: 'cmp_1', format: 'ascii_panel', min_wait_ms: 8000,
    render: {
      text: 'Acme', lines: ['Acme'], cta: 'acme.dev', color: 'cyan', emoji: null,
      art_lines: [[{ t: ' ACME ', fg: 'bright_white', bold: true }]], game: 'runner', ...render,
    },
    ...extra,
  };
  const signature = crypto.sign(null, Buffer.from(canonicalAdJson(ad)), keys.privateKey).toString('base64');
  return { ...ad, price_micros: 8000, pricing_model: 'cpm', signature };
}

function cacheDir(ads, { pub = pubB64 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-skin-'));
  fs.writeFileSync(path.join(dir, 'cache.json'), JSON.stringify({ pack_id: 'p', fetched_at: 1, ttl_seconds: 900, ads }));
  if (pub) fs.writeFileSync(path.join(dir, 'pubkey.json'), JSON.stringify({ algorithm: 'ed25519', public_key_b64: pub, fetched_at: 1 }));
  return dir;
}

test('skin: constants match the files adcache.js actually writes', () => {
  assert.equal(skin.CACHE_FILE, adcache.CACHE_FILE);
  assert.equal(skin.PUBKEY_FILE, adcache.PUBKEY_FILE);
});

test('skin: a validly signed game ad for the right game draws, with the sponsored disclosure', () => {
  const ad = signedAd();
  const dir = cacheDir([ad]);
  const lines = skin.loadSkin({ dir, adId: ad.ad_id, game: 'runner', cols: 80, rows: 24 });
  assert.ok(lines.length > 0);
  const text = lines.join('\n');
  assert.match(text, /ACME/);
  assert.match(text, /sponsored/);
  const s = new PlaySession({ game: 'runner', dir, skinLines: lines });
  assert.match(s.render(80, 40).join('\n'), /ACME/);
});

test('skin: tampered art, a swapped game id, or a signature from another key → no skin', () => {
  const ad = signedAd();
  const tampered = { ...ad, render: { ...ad.render, art_lines: [[{ t: ' EVIL ', fg: 'red' }]] } };
  assert.deepEqual(skin.loadSkin({ dir: cacheDir([tampered]), adId: ad.ad_id, game: 'runner' }), []);

  const swapped = { ...ad, render: { ...ad.render, game: 'termo' } };
  assert.deepEqual(skin.loadSkin({ dir: cacheDir([swapped]), adId: ad.ad_id, game: 'termo' }), []);

  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.deepEqual(skin.loadSkin({ dir: cacheDir([ad], { pub: other }), adId: ad.ad_id, game: 'runner' }), []);
});

test('skin: wrong game, unknown id, no pubkey, no cache, legacy ad without `game` → no skin (game still plays)', () => {
  const ad = signedAd();
  const dir = cacheDir([ad]);
  assert.deepEqual(skin.loadSkin({ dir, adId: ad.ad_id, game: 'termo' }), [], 'ad is for runner');
  assert.deepEqual(skin.loadSkin({ dir, adId: 'ad_nope', game: 'runner' }), []);
  assert.deepEqual(skin.loadSkin({ dir, adId: undefined, game: 'runner' }), []);
  assert.deepEqual(skin.loadSkin({ dir: cacheDir([ad], { pub: null }), adId: ad.ad_id, game: 'runner' }), []);
  assert.deepEqual(skin.loadSkin({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-empty-')), adId: ad.ad_id, game: 'runner' }), []);

  const legacy = signedAd({ game: undefined });
  assert.equal(legacy.render.game, undefined);
  assert.equal(require('../src/signature').verifyAd(legacy, pubB64), true, 'a pre-game ad still verifies');
  assert.deepEqual(skin.loadSkin({ dir: cacheDir([legacy]), adId: legacy.ad_id, game: 'runner' }), []);

  assert.deepEqual(skin.loadSkin({ dir, adId: ad.ad_id, game: 'doom' }), [], 'unknown game id');
});

test('cache writes are atomic: rotation + refresh leave no tmp files and valid JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-atomic-'));
  const cache = new adcache.AdCache({ dir, apiUrl: 'http://unused' });
  const ads = [{ ad_id: 'a' }, { ad_id: 'b' }];
  for (let i = 0; i < 50; i++) {
    cache.nextAd(ads);
    JSON.parse(fs.readFileSync(path.join(dir, 'cache.json'), 'utf8'));
  }
  assert.deepEqual(fs.readdirSync(dir), ['cache.json']);
});

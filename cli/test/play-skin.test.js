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

// ── every GAME_ID skins, and the banner fits each board at 80x24 ─────────────

const { GAME_IDS } = require('../src/creative');
const term = require('../src/play/term');
const strip = (l) => l.replace(/\x1b\[[0-9;]*m/g, '');
const TALL_ART = Array.from({ length: 6 }, (_, i) => [{ t: ` ACME LINE ${i} `, fg: 'bright_white' }]);

test('skin: findSkinAd/loadSkin work for every id in GAME_IDS (and only for the ad\'s own game)', () => {
  for (const game of GAME_IDS) {
    const ad = signedAd({ game, art_lines: TALL_ART });
    const dir = cacheDir([ad]);
    assert.ok(skin.findSkinAd({ dir, adId: ad.ad_id, game }), `${game}: verified`);
    assert.match(skin.loadSkin({ dir, adId: ad.ad_id, game, cols: 80, rows: 24 }).join('\n'), /sponsored/, game);
    const other = GAME_IDS.find((g) => g !== game);
    assert.equal(skin.findSkinAd({ dir, adId: ad.ad_id, game: other }), null, `${game} ad does not skin ${other}`);
  }
});

test('skin: at 80x24 every game keeps its board whole AND the "sponsored" label (banner shrinks, never the label)', () => {
  for (const depth of ['truecolor', 'none']) {
    for (const game of GAME_IDS) {
      const ad = signedAd({ game, art_lines: TALL_ART });
      const dir = cacheDir([ad]);
      const { options, card } = skin.skinVariants({ dir, adId: ad.ad_id, game, cols: 80, rows: 24 });
      assert.ok(options.length >= 2, `${game}: has smaller variants`);
      assert.ok(options.every((o) => /sponsored/.test(o.map(strip).join('\n'))), `${game}: every variant carries "sponsored"`);
      assert.match(strip(card), /sponsored/);
      const bare = new PlaySession({ game, dir, style: term.makeStyle(depth) }).render(80, 24);
      const withSkin = new PlaySession({ game, dir, skinLines: options[0], skinOptions: options, skinCard: card, style: term.makeStyle(depth) }).render(80, 24);
      assert.equal(withSkin.length, 24);
      const text = withSkin.map(strip).join('\n');
      assert.match(text, /sponsored/, `${game}/${depth}: label visible`);
      // The board is intact: the same non-empty rows as without a banner, minus the optional hint line.
      const rowsOf = (lines) => lines.map(strip).filter((l) => l.trim());
      const boardRows = rowsOf(bare).length - 2; // status bar + hint may give way
      assert.ok(rowsOf(withSkin).length >= boardRows + 1, `${game}/${depth}: board not cut (${rowsOf(withSkin).length} vs ${boardRows})`);
    }
  }
});

test('skin: a roomy terminal takes the full panel; a short one steps down to 2 rows, then 1', () => {
  const ad = signedAd({ game: 'termo', art_lines: TALL_ART });
  const dir = cacheDir([ad]);
  const { options } = skin.skinVariants({ dir, adId: ad.ad_id, game: 'termo', cols: 80, rows: 24 });
  const mk = () => new PlaySession({ game: 'termo', dir, skinLines: options[0], skinOptions: options, style: term.makeStyle('none') });
  assert.match(mk().render(80, 60).map(strip).join('\n'), /ACME LINE 4/, 'tall: whole art');
  assert.doesNotMatch(mk().render(80, 16).map(strip).join('\n'), /ACME LINE 4/, 'short: art gave way');
  assert.match(mk().render(80, 16).map(strip).join('\n'), /sponsored/);
});

test('skin: the freeze card carries the sponsor row INSIDE the card, under the title, with no banner above', () => {
  const ad = signedAd({ game: 'snake', art_lines: TALL_ART });
  const dir = cacheDir([ad]);
  const { options, card } = skin.skinVariants({ dir, adId: ad.ad_id, game: 'snake', cols: 80, rows: 24 });
  const s = new PlaySession({ game: 'snake', dir, skinLines: options[0], skinOptions: options, skinCard: card, style: term.makeStyle('none') });
  require('../src/play/bridge').writeState(dir, 'idle', Date.now());
  s.poll();
  assert.equal(s.gate, 'frozen');
  const lines = s.render(80, 24).map(strip);
  const iTitle = lines.findIndex((l) => /│.*[✔✓]/.test(l));
  const iSponsor = lines.findIndex((l) => /│.*sponsored.*│/.test(l));
  assert.ok(iTitle >= 0 && iSponsor === iTitle + 1, `sponsor directly under the title (${iTitle}, ${iSponsor})`);
  assert.equal(lines.filter((l) => /sponsored/.test(l)).length, 1, 'one sponsor row, no banner above the card');
});

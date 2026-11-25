'use strict';

/**
 * Sponsored skin for `meshad play --ad <ad_id>`.
 *
 * `meshad run --play` picks the ad and hands its id to the play pane; play then
 * reads the pack from the local cache and RE-VERIFIES the Ed25519 signature
 * against the locally cached public key before drawing a single cell of it.
 * Any failure — no cache, no key, bad signature, wrong game, unknown id — means
 * "no skin": the game is still played, unsponsored. Offline: no network here.
 *
 * A skin is the ad's own signed ascii_panel art, drawn above the game with the
 * standard "sponsored" disclosure line. The game's colours are fixed; the
 * advertiser never supplies a palette or an escape sequence.
 */

const fs = require('node:fs');
const path = require('node:path');
const { verifyAd } = require('../signature');
const { formatAd } = require('../render');
const { GAME_IDS } = require('../creative');

// Same files adcache.js writes (a test pins the match). Not imported from there:
// adcache pulls in the network module, and play must stay offline end to end.
const CACHE_FILE = 'cache.json';
const PUBKEY_FILE = 'pubkey.json';

function readJson(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch {
    return null;
  }
}

/** The verified ad for `adId` that is skinned for `game`, or null. */
function findSkinAd({ dir, adId, game }) {
  if (!adId || !GAME_IDS.includes(game)) return null;
  const cache = readJson(dir, CACHE_FILE);
  const key = readJson(dir, PUBKEY_FILE);
  if (!cache || !Array.isArray(cache.ads) || !key || key.algorithm !== 'ed25519' || !key.public_key_b64) return null;
  const ad = cache.ads.find((a) => a && a.ad_id === adId);
  if (!ad || ad.format !== 'ascii_panel' || !ad.render || ad.render.game !== game) return null;
  return verifyAd(ad, key.public_key_b64) ? ad : null;
}

/**
 * Palette accent for a verified skin, derived from the ad's own SIGNED `render.color`
 * (a closed set of colour names) — the advertiser never ships a hex value, and the
 * signed canonical schema is unchanged. Unknown or missing → null (default palette).
 */
const ACCENT_BY_COLOR = {
  cyan: 'cyan', bright_cyan: 'cyan', magenta: 'magenta', bright_magenta: 'magenta', green: 'lime', bright_green: 'lime',
  yellow: 'amber', bright_yellow: 'amber', red: 'red', bright_red: 'red', blue: 'sky', bright_blue: 'sky',
};

function skinAccent(ad) {
  const name = ad && ad.render && typeof ad.render.color === 'string' ? ad.render.color : '';
  return Object.prototype.hasOwnProperty.call(ACCENT_BY_COLOR, name) ? ACCENT_BY_COLOR[name] : null;
}

/** Banner lines (ANSI strings) for the verified skin ad, or [] when there is none. */
function loadSkin({ dir, adId, game, cols = 80, rows = 24 }) {
  const ad = findSkinAd({ dir, adId, game });
  return ad ? formatAd(ad, cols, rows) : [];
}

module.exports = { findSkinAd, loadSkin, skinAccent, CACHE_FILE, PUBKEY_FILE };

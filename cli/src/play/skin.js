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
const { GAME_IDS, parseRenderColors } = require('../creative');

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
 * Palette accent for a verified skin. A valid signed `render.colors` v1 brand colour
 * wins and is returned as `{ brand: '#rrggbb' }` (term.js maps it to the terminal's
 * depth; NO_COLOR draws none). Otherwise it is derived from the signed `render.color`
 * (a closed set of names). Unknown `v`, bad hex, or nothing → null (default palette).
 */
const ACCENT_BY_COLOR = {
  cyan: 'cyan', bright_cyan: 'cyan', magenta: 'magenta', bright_magenta: 'magenta', green: 'lime', bright_green: 'lime',
  yellow: 'amber', bright_yellow: 'amber', red: 'red', bright_red: 'red', blue: 'sky', bright_blue: 'sky',
};

function skinAccent(ad) {
  const brand = parseRenderColors(ad && ad.render && ad.render.colors);
  if (brand) return { brand: brand.brand };
  const name = ad && ad.render && typeof ad.render.color === 'string' ? ad.render.color : '';
  return Object.prototype.hasOwnProperty.call(ACCENT_BY_COLOR, name) ? ACCENT_BY_COLOR[name] : null;
}

/** Banner lines (ANSI strings) for the verified skin ad, or [] when there is none. */
function loadSkin({ dir, adId, game, cols = 80, rows = 24 }) {
  const ad = findSkinAd({ dir, adId, game });
  return ad ? formatAd(ad, cols, rows) : [];
}

/**
 * Banner sizes for a verified skin, tallest first, so a game can take the biggest one that
 * leaves its board whole: the full panel, then 2 rows (first art row + the sponsor row, still
 * framed at the sides), then the 1-line form. Every variant carries the "sponsored" label —
 * it is never the part that gets cut. `card` is the one-line sponsor row for the freeze card.
 * No verified skin → { options: [], card: '' }.
 */
function skinVariants({ dir, adId, game, cols = 80, rows = 24 }) {
  const ad = findSkinAd({ dir, adId, game });
  return ad ? variantsFor(ad, cols, rows) : { options: [], card: '' };
}

function variantsFor(ad, cols, rows) {
  const full = formatAd(ad, cols, rows);
  if (!full.length) return { options: [], card: '' };
  const out = [full];
  if (full.length > 3) out.push([full[1], full[full.length - 2]]); // framed panel: top art row + sponsor row
  const one = formatAd(ad, cols, 0); // rows < MIN_ROWS_ART → the single flattened line
  if (one.length === 1 && full.length > 1) out.push(one);
  // The sponsor line for the freeze card, sized to fit INSIDE the card (its border and padding take 7 columns).
  const card = formatAd(ad, Math.max(20, cols - 7), 0)[0] || '';
  return { options: out, card };
}

module.exports = { findSkinAd, loadSkin, skinVariants, skinAccent, CACHE_FILE, PUBKEY_FILE };

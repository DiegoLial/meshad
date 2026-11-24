/**
 * Ad signature verification — the client half of the Ed25519 contract.
 *
 * Pure and offline: no network, no disk. Split out of adcache.js so the
 * embeddable SDK (packages/sdk) can vendor the EXACT same canonicalization the
 * CLI renders against — two clients disagreeing on which bytes are signed
 * would mean one of them renders something moderation never approved.
 * packages/sdk/lib/signature.js is a body-identical copy; keep both in sync
 * with `make sync-vendored` (packages/sdk/test/vendor-sync.test.js enforces it).
 */
'use strict';

const crypto = require('node:crypto');

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
      // Optional playable-game skin id (ascii_panel only). Undefined → omitted,
      // so every ad signed before `game` existed keeps its exact bytes.
      game: render.game,
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

module.exports = { canonicalAdJson, verifyAd };

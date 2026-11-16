'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { HYPOTHETICAL_ADS } = require('../src/hypothetical');
const { validateFrames } = require('../src/creative');

test('every bundled hypothetical ad honors the creative contract', () => {
  assert.ok(HYPOTHETICAL_ADS.length >= 6, 'a useful pack has variety');
  for (const ad of HYPOTHETICAL_ADS) {
    assert.strictEqual(ad.format, 'ascii_panel', `${ad.ad_id} format`);
    assert.ok(ad.render.cta, `${ad.ad_id} has a cta`);
    assert.strictEqual(ad.price_micros, 0, `${ad.ad_id} must be free — hypothetical ads never bill`);
    const v = validateFrames({ frames: ad.render.frames });
    assert.ok(v.ok, `${ad.ad_id}: ${v.ok ? '' : v.reasons.join(', ')}`);
  }
});

test('hypothetical pack uses only fictional brands (no real trademarks)', () => {
  const REAL = /vercel|docker|copilot|stripe|mongo|aws|amazon|neon\b|datadog|cloudflare|tailscale|supabase|redis|sentry|\bbun\b|\bnpm\b|fly\.io|digitalocean|grafana|\bv0\b|linear|github|\bgh\b/i;
  for (const ad of HYPOTHETICAL_ADS) {
    const text = [ad.ad_id, ad.render.cta, ...ad.render.frames.flatMap((f) => f.art_lines.flat().map((sp) => sp.t))].join(' ');
    assert.doesNotMatch(text, REAL, `${ad.ad_id} mentions a real brand`);
  }
});

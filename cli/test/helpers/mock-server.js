'use strict';

/**
 * Minimal mock of the MeshAd API (per CONTRACT.md) for CLI tests.
 * Real Ed25519 keys, real signatures — so signature verification in the
 * client is exercised for real. Records every telemetry batch it receives.
 */

const http = require('node:http');
const crypto = require('node:crypto');

function canonicalAdJson(ad) {
  return JSON.stringify({
    ad_id: ad.ad_id,
    campaign_id: ad.campaign_id,
    format: ad.format,
    min_wait_ms: ad.min_wait_ms,
    render: {
      text: ad.render.text,
      lines: ad.render.lines,
      cta: ad.render.cta,
      color: ad.render.color,
      emoji: ad.render.emoji ?? null,
    },
  });
}

function startMockServer({ minWaitMs = 3000, tamperSignatures = false } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  const received = { batches: [], events: [] };

  const makeAd = (n) => {
    const text = `▲ MockTool ${n} — ship faster`;
    const ad = {
      ad_id: `ad_mock${n}aaaa`,
      campaign_id: `cmp_mock${n}`,
      format: 'text_line',
      min_wait_ms: minWaitMs,
      render: { text, lines: [text], cta: `mesh.io/mock${n}`, color: 'dim', emoji: null },
    };
    let signature = crypto.sign(null, Buffer.from(canonicalAdJson(ad)), privateKey).toString('base64');
    if (tamperSignatures) signature = Buffer.from('bogus-signature-bytes-here').toString('base64');
    return { ...ad, price_micros: 8000, pricing_model: 'cpm', signature };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/v1/keys/public') {
      return json(200, { algorithm: 'ed25519', public_key_b64: publicKeyB64 });
    }
    if (req.method === 'GET' && url.pathname === '/v1/ads/pack') {
      return json(200, { pack_id: 'pk_mock', ttl_seconds: 900, ads: [makeAd(1), makeAd(2)] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/telemetry/events') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        received.batches.push(parsed);
        received.events.push(...parsed.events);
        json(202, { accepted: parsed.events.length });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/publisher/register') {
      return json(201, { account_id: 'acct_mock', api_key: 'aa_pub_mockmockmock' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/publisher/devices') {
      return json(201, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/v1/publisher/earnings') {
      return json(200, { currency: 'USD', total_micros: 5600, pending_micros: 5600, available_micros: 0, rows: [] });
    }
    json(404, { error: { code: 'not_found', message: url.pathname } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        received,
        close: () =>
          new Promise((r) => {
            // fetch()'s pooled keep-alive sockets would otherwise hold close() forever
            server.closeAllConnections();
            server.close(r);
          }),
      });
    });
  });
}

module.exports = { startMockServer };

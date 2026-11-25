'use strict';

/**
 * Minimal mock of the MeshAd API (per CONTRACT.md) for CLI tests.
 * Real Ed25519 keys, real signatures — so signature verification in the
 * client is exercised for real. Records every telemetry batch it receives.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { canonicalAdJson: realCanonicalAdJson } = require('../../src/signature');

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

const DEFAULT_NEWS_ITEMS = [
  { id: 'n1', topic: 'lang:rust', topics: ['lang:rust'], title: 'The Rust blog: releases', url: 'https://blog.rust-lang.org/', source: 'blog.rust-lang.org' },
  { id: 'n2', topic: 'lang:python', topics: ['lang:python'], title: "What's new in Python", url: 'https://docs.python.org/3/whatsnew/', source: 'docs.python.org' },
  { id: 'n3', topic: 'topic:security', topics: ['topic:security'], title: 'OWASP Top Ten', url: 'https://owasp.org/www-project-top-ten/', source: 'owasp.org' },
];

function startMockServer({ minWaitMs = 3000, tamperSignatures = false, gameAd = null, newsItems = DEFAULT_NEWS_ITEMS, noAds = false } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  // `games`: every leaderboard call, with the Authorization header as sent.
  const received = { batches: [], events: [], games: [], news: [] };

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

  // A signed ascii_panel ad carrying render.game, using the REAL canonical form
  // (the legacy local copy above predates art_lines/game). `gameAd` = 'runner'|'termo'.
  const makeGameAd = (game) => {
    const ad = {
      ad_id: `ad_game${game}`,
      campaign_id: 'cmp_game',
      format: 'ascii_panel',
      min_wait_ms: minWaitMs,
      render: {
        text: 'Mock Game Skin', lines: ['Mock Game Skin'], cta: 'mesh.io/game', color: 'cyan', emoji: null,
        art_lines: [[{ t: ' MOCK SKIN ', fg: 'bright_white', bold: true }]],
        game,
      },
    };
    const signature = crypto.sign(null, Buffer.from(realCanonicalAdJson(ad)), privateKey).toString('base64');
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
      return json(200, { pack_id: 'pk_mock', ttl_seconds: 900, ads: noAds ? [] : [...(gameAd ? [makeGameAd(gameAd)] : []), makeAd(1), makeAd(2)] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/news/feed') {
      received.news.push({ search: url.search, auth: req.headers.authorization || null, url: req.url });
      return json(200, { updated_at: new Date().toISOString(), ttl_seconds: 900, taxonomy: [], items: newsItems });
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
    if (url.pathname.startsWith('/v1/games/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : null;
        received.games.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || null, body: parsed });
        if (req.method === 'POST' && url.pathname === '/v1/games/handles') {
          if (parsed.handle === 'taken_one') return json(409, { error: { code: 'handle_taken', message: 'that handle is already taken' } });
          return json(201, { handle: parsed.handle, token: `gh_${'M'.repeat(40)}` });
        }
        if (req.method === 'POST' && url.pathname === '/v1/games/scores') {
          if (parsed.score === 999) return json(422, { error: { code: 'replay_mismatch', message: 'nope' } });
          return json(201, { accepted: true, handle: 'mockhandle', game: parsed.game, date: parsed.date, score: parsed.score, best: parsed.score, improved: true });
        }
        if (req.method === 'DELETE' && url.pathname === '/v1/games/handles/me') {
          res.writeHead(204);
          return res.end();
        }
        json(404, { error: { code: 'not_found', message: url.pathname } });
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
      const url = `http://127.0.0.1:${server.address().port}`;
      // net.js only lets the client reach this loopback mock via the documented
      // developer override — the same MESHAD_API_URL escape hatch a dev uses to
      // point at a self-hosted gateway. Setting it here keeps the egress
      // allowlist fully enforced in tests instead of poking a hole in net.js.
      const prevApiUrl = process.env.MESHAD_API_URL;
      process.env.MESHAD_API_URL = url;
      resolve({
        url,
        received,
        close: () =>
          new Promise((r) => {
            if (prevApiUrl === undefined) delete process.env.MESHAD_API_URL;
            else process.env.MESHAD_API_URL = prevApiUrl;
            // fetch()'s pooled keep-alive sockets would otherwise hold close() forever
            server.closeAllConnections();
            server.close(r);
          }),
      });
    });
  });
}

module.exports = { startMockServer };

'use strict';

/**
 * The client's SINGLE network egress point. Nothing else in src/ is allowed to
 * reach the network — a source-scan test (test/egress-boundary.test.js) fails
 * the build if any other file references `fetch`, `node:http(s)`, `node:net`,
 * `node:tls` or `node:dgram`. That makes "egress lives in one auditable module"
 * an enforced property, not a convention (the honest, JS-native equivalent of
 * the whitepaper's "network symbols only in the uplink module").
 *
 * Two guarantees live here:
 *
 *  1. Host allowlist (always on). A request whose host is not in ALLOWED_HOSTS
 *     is refused BEFORE any connection is attempted. The list is hard-coded in
 *     source — never read from config or env — so a tampered config cannot
 *     redirect egress. The one escape hatch is the developer override below.
 *
 *  2. SPKI pinning — NOT YET ENFORCED (follow-up). The pure pin helper
 *     (`spkiSha256Base64`) lives here and is unit-tested, but enforcement is
 *     deliberately not wired yet, for two honest reasons: (a) pinning a Let's
 *     Encrypt leaf while Caddy rotates the key every ~90 days would brick every
 *     client on renewal — the server must first keep a STABLE TLS key; and (b)
 *     doing it without adding `undici` as a dependency (which would break this
 *     CLI's zero-dependency guarantee) needs a node:https path tested against a
 *     real pinned endpoint. Arming is its own reviewed change once the server
 *     key is stable; see PINS below.
 *
 * Developer override: when MESHAD_API_URL points at a host OUTSIDE the public
 * allowlist (self-host, integration tests), egress to THAT origin is allowed
 * with a loud one-time stderr warning, and pinning is skipped. The public
 * hosts remain locked down regardless.
 */

const crypto = require('node:crypto');

// The only hosts the public client ever talks to. Hard-coded on purpose.
// `api.meshad.io` serves telemetry, ads, keys, publisher API and transparency;
// `meshad.io` serves the CLI tarball for `meshad update`. A future split into
// telemetry.meshad.io / ads.meshad.io (backlog: new DNS + Caddy hosts) just
// adds entries here.
const ALLOWED_HOSTS = new Set(['api.meshad.io', 'meshad.io']);

/**
 * SPKI pins per host: { host: [primaryBase64, backupBase64, ...] }. Empty and
 * NOT YET consulted by meshFetch — arming is a separate reviewed change (see the
 * header note). To arm: (1) configure the server's Caddy to keep a stable TLS
 * key across renewals, (2) `spkiSha256Base64(new crypto.X509Certificate(...))`
 * against that cert, (3) list the pin here WITH a backup pin already embedded so
 * a planned rotation never bricks clients, (4) wire enforcement via node:https
 * checkServerIdentity (kept zero-dependency).
 */
const PINS = Object.create(null);

/** Base64 SHA-256 of a cert's SubjectPublicKeyInfo — the pin value. */
function spkiSha256Base64(x509) {
  // `x509` is a node:crypto X509Certificate; publicKey.export({type:'spki'})
  // is the DER SubjectPublicKeyInfo the pin is computed over.
  const spki = x509.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(spki).digest('base64');
}

function devOverrideHost() {
  const raw = process.env.MESHAD_API_URL;
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

let warned = false;
function warnCarveOutOnce(host) {
  if (warned) return;
  warned = true;
  process.stderr.write(
    `meshad: egress pinning/allowlist DISABLED for ${host} — not the public ` +
      `MeshAd network (MESHAD_API_URL override). Never use this against a host you don't trust.\n`,
  );
}

/**
 * The one function allowed to touch the network. Same call shape as global
 * fetch. Enforces the host allowlist; applies SPKI pinning when armed for the
 * target host; honours the developer override.
 */
async function meshFetch(url, opts = {}) {
  const host = new URL(url).host;

  if (ALLOWED_HOSTS.has(host)) {
    return globalThis.fetch(url, opts);
  }

  const dev = devOverrideHost();
  if (dev && host === dev) {
    warnCarveOutOnce(host);
    return globalThis.fetch(url, opts);
  }

  throw new Error(`meshad: refusing egress to non-allowlisted host: ${host}`);
}

module.exports = { meshFetch, spkiSha256Base64, ALLOWED_HOSTS, PINS };

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const i18n = require('../i18n');
const { c, parseFlags, SDK_VERSION } = require('../util');
const { meshFetch } = require('../net');

const TARBALL_URL = process.env.MESHAD_TARBALL_URL || 'https://meshad.io/meshad-cli.tgz';

const HELP = `
  meshad update — reinstall the CLI from the network's published tarball

  Downloads ${TARBALL_URL} through the client's audited, host-allowlisted
  egress module, verifies its SHA-256 against ${TARBALL_URL}.sha256, and only
  then installs the VERIFIED LOCAL FILE via npm — npm never fetches the artifact
  from an arbitrary host. Your config, device identity and earnings are
  untouched (they live in ~/.config/meshad, not in the package).
`;

/** Version of the globally installed package after the reinstall, or null. */
function installedVersion() {
  const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (root.status !== 0) return null;
  try {
    const pkg = path.join(root.stdout.trim(), '@meshad', 'cli', 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || null;
  } catch {
    return null;
  }
}

/**
 * True iff `bytes` hashes to the expected SHA-256. `expected` is the first
 * whitespace-separated token of a sha256sum-style line (`<hex>  filename`).
 * Exported for unit testing the integrity gate without touching the network.
 */
function checksumMatches(bytes, expected) {
  const want = String(expected || '').trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return false;
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  return got === want;
}

module.exports = async function update(cmd, argv) {
  const { flags } = parseFlags(argv, { help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  console.log(i18n.t('update.fetching', { version: SDK_VERSION, url: TARBALL_URL }));

  // 1. Fetch the tarball AND its checksum through the single audited egress
  //    module (host-allowlisted). A raw `npm install <url>` — the old path —
  //    was an unpinned egress + code-execution channel to an arbitrary host.
  let tarballBytes;
  let checksumLine;
  try {
    const res = await meshFetch(TARBALL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tarballBytes = Buffer.from(await res.arrayBuffer());
    const sumRes = await meshFetch(`${TARBALL_URL}.sha256`);
    if (!sumRes.ok) throw new Error(`checksum HTTP ${sumRes.status}`);
    checksumLine = await sumRes.text();
  } catch (e) {
    console.error(`${c.red('error:')} could not fetch update over the egress module: ${e.message}`);
    return 1;
  }

  // 2. Integrity gate — refuse to install a tarball that doesn't match the
  //    published checksum, BEFORE anything touches the system.
  if (!checksumMatches(tarballBytes, checksumLine)) {
    console.error(`${c.red('error:')} update checksum mismatch — refusing to install`);
    return 1;
  }

  // 3. Install the VERIFIED LOCAL FILE. npm resolves nothing from the network
  //    for the artifact itself (the CLI has zero runtime dependencies).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshad-update-'));
  const tmp = path.join(tmpDir, 'meshad-cli.tgz');
  fs.writeFileSync(tmp, tarballBytes);
  try {
    const npm = spawnSync('npm', ['install', '-g', tmp, '--no-audit', '--no-fund'], {
      stdio: 'inherit',
    });
    if (npm.error && npm.error.code === 'ENOENT') {
      console.error(`${c.red('error:')} ${i18n.t('update.noNpm')}`);
      return 1;
    }
    if (npm.status !== 0) {
      console.error(`${c.red('error:')} ${i18n.t('update.failed')}`);
      return 1;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const now = installedVersion();
  if (now && now !== SDK_VERSION) {
    console.log(`  ${c.green('✓')} ${i18n.t('update.updated', { from: SDK_VERSION, to: now })}`);
  } else {
    console.log(`  ${c.green('✓')} ${i18n.t('update.current', { version: now || SDK_VERSION })}`);
  }
  return 0;
};

module.exports.checksumMatches = checksumMatches;

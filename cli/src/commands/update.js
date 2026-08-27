'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const i18n = require('../i18n');
const { c, parseFlags, SDK_VERSION } = require('../util');

const HELP = `
  meshad update — reinstall the CLI from the network's published tarball

  Installs ${'MESHAD_TARBALL_URL' in process.env ? process.env.MESHAD_TARBALL_URL : 'https://meshad.io/meshad-cli.tgz'}
  over the current global install via npm. Your config, device identity and
  earnings are untouched (they live in ~/.config/meshad, not in the package).
`;

const TARBALL_URL = process.env.MESHAD_TARBALL_URL || 'https://meshad.io/meshad-cli.tgz';

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

module.exports = async function update(cmd, argv) {
  const { flags } = parseFlags(argv, { help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  console.log(i18n.t('update.fetching', { version: SDK_VERSION, url: TARBALL_URL }));
  const npm = spawnSync('npm', ['install', '-g', TARBALL_URL, '--no-audit', '--no-fund'], {
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

  const now = installedVersion();
  if (now && now !== SDK_VERSION) {
    console.log(`  ${c.green('✓')} ${i18n.t('update.updated', { from: SDK_VERSION, to: now })}`);
  } else {
    console.log(`  ${c.green('✓')} ${i18n.t('update.current', { version: now || SDK_VERSION })}`);
  }
  return 0;
};

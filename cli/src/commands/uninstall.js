'use strict';

const fs = require('node:fs');
const readline = require('node:readline/promises');
const config = require('../config');
const i18n = require('../i18n');
const { c, parseFlags } = require('../util');

const HELP = `
  meshad uninstall — remove every local trace of MeshAd

  Deletes the whole config dir (config, ad cache, telemetry queue,
  last batch, reports). Asks for confirmation unless --yes.
`;

module.exports = async function uninstall(_cmd, argv) {
  const { flags } = parseFlags(argv, { yes: 'bool', help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  i18n.init(config.load());
  const { t } = i18n;
  const dir = config.configDir();

  if (!fs.existsSync(dir)) {
    console.log(c.dim(t('uninstall.nothing', { dir })));
    return 0;
  }

  if (!flags.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`  ${t('uninstall.confirm', { dir })}`);
      if (!i18n.isYes(answer)) {
        console.log(c.dim(`  ${t('uninstall.cancelled')}`));
        return 0;
      }
    } finally {
      rl.close();
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${c.green('✓')} ${t('uninstall.removed', { dir })}`);
  console.log(c.dim(`  ${t('uninstall.thanks')}`));
  return 0;
};

'use strict';

const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const config = require('../config');
const i18n = require('../i18n');
const { request } = require('../api');
const { c, parseFlags, platform, SDK_VERSION } = require('../util');

const HELP = `
  meshad init — explicit opt-in + registration

  Shows exactly what is (and is never) collected, asks for consent,
  registers you as a publisher and this machine as a device.

  Options:
    --yes            non-interactive consent (CI); requires --email
    --email <addr>   e-mail for the publisher account
    --help
`;

function consentText(t) {
  return `
  ${c.bold(t('init.consent.title'))}

  ${c.bold(t('init.consent.collectTitle'))}
    1. ${t('init.consent.item1')}
    2. ${t('init.consent.item2')}
    3. ${t('init.consent.item3')}
    4. ${t('init.consent.item4')}
    5. ${t('init.consent.item5')}

  ${c.bold(t('init.consent.neverTitle'))}
    ${t('init.consent.neverBody')}

  ${c.dim(t('init.consent.inspect'))}
  ${c.dim(t('init.consent.pause'))}
`;
}

module.exports = async function init(_cmd, argv) {
  const { flags } = parseFlags(argv, { yes: 'bool', email: 'string', help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = config.load();
  i18n.init(cfg);
  const { t } = i18n;

  if (cfg.api_key) {
    console.log(
      `${c.yellow(t('init.already'))} (${config.configPath()}). ${t('init.startOver', { cmd: c.bold('meshad uninstall') })}`
    );
    return 0;
  }

  console.log(consentText(t));

  let email = flags.email;
  if (flags.yes) {
    if (!email) {
      console.error(`${c.red('error:')} --yes requires --email <addr>`);
      return 2;
    }
    console.log(c.dim(`  ${t('init.acceptedNonInteractive')}`));
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`  ${t('init.accept')}`);
      if (!i18n.isYes(answer)) {
        console.log(c.dim(`  ${t('init.declined')}`));
        return 0;
      }
      if (!email) email = (await rl.question(`  ${t('init.emailPrompt')}`)).trim();
    } finally {
      rl.close();
    }
  }
  if (!email || !email.includes('@')) {
    console.error(`${c.red('error:')} ${t('err.emailRequired')}`);
    return 2;
  }

  const apiUrl = config.apiUrl(cfg);
  const reg = await request(apiUrl, 'POST', '/v1/publisher/register', { body: { email } });

  cfg.api_key = reg.api_key;
  cfg.account_id = reg.account_id;
  cfg.anon_id = crypto.randomUUID();
  cfg.api_url = apiUrl;
  config.save(cfg);

  await request(apiUrl, 'POST', '/v1/publisher/devices', {
    apiKey: cfg.api_key,
    body: { anon_id: cfg.anon_id, platform: platform(), sdk_version: SDK_VERSION },
  });

  console.log('');
  console.log(`  ${c.green('✓')} ${t('init.registered', { email })} ${c.dim(`(${reg.account_id})`)}`);
  console.log(`  ${c.green('✓')} ${t('init.device', { anonId: cfg.anon_id })}`);
  console.log(`  ${c.green('✓')} ${t('init.saved', { path: config.configPath() })} ${c.dim('(0600)')}`);
  console.log('');
  console.log(
    `  ${t('init.tryIt', { demo: c.bold('meshad demo'), earnings: c.bold('meshad earnings'), pause: c.bold('meshad pause') })}`
  );
  return 0;
};

'use strict';

const config = require('../config');
const i18n = require('../i18n');
const { request } = require('../api');
const { c, parseFlags } = require('../util');

const HELP = `
  meshad pause [1h|1d|forever] — stop showing ads (no penalty, no dark patterns)
  meshad resume               — start showing ads again

  Pause takes effect locally and immediately, even offline; the server
  preference (PATCH /v1/publisher/me) is synced best-effort.
`;

const DURATIONS = { '1h': 3600000, '1d': 86400000 };

module.exports = async function pause(cmd, argv) {
  const { flags, rest } = parseFlags(argv, { help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = config.load();
  i18n.init(cfg);
  const { t } = i18n;

  if (!config.exists()) {
    console.error(`${c.red('error:')} ${t('err.notInitialized')} ${c.bold('meshad init')}`);
    return 1;
  }

  let pausedRemote;
  if (cmd === 'resume') {
    cfg.paused_until = null;
    pausedRemote = false;
    console.log(`${c.green('✓')} ${t('pause.resumed')}`);
  } else {
    const arg = rest[0] || 'forever';
    if (arg === 'forever') {
      cfg.paused_until = 'forever';
      console.log(`${c.green('✓')} ${t('pause.forever')} ${c.dim(t('pause.foreverHint'))}`);
    } else if (DURATIONS[arg]) {
      cfg.paused_until = Date.now() + DURATIONS[arg];
      console.log(`${c.green('✓')} ${t('pause.until', { ts: new Date(cfg.paused_until).toISOString() })}`);
    } else {
      console.error(`${c.red('error:')} ${t('pause.badArg')}`);
      return 2;
    }
    pausedRemote = true;
  }
  config.save(cfg); // local first — works offline

  if (cfg.api_key) {
    try {
      await request(config.apiUrl(cfg), 'PATCH', '/v1/publisher/me', {
        apiKey: cfg.api_key,
        body: { ads_paused: pausedRemote },
        timeoutMs: 3000,
      });
    } catch {
      console.log(c.dim(`  ${t('pause.offline')}`));
    }
  }
  return 0;
};

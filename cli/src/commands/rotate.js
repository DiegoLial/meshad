'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { request } = require('../api');
const { c, parseFlags, platform, SDK_VERSION } = require('../util');

const HELP = `
  meshad rotate-id — generate a fresh anon_id and re-register this device

  The old ID is discarded locally; future telemetry is unlinkable to it.
`;

module.exports = async function rotate(_cmd, argv) {
  const { flags } = parseFlags(argv, { help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = config.load();
  if (!cfg.api_key) {
    console.error(`${c.red('error:')} not initialized — run ${c.bold('meshad init')}`);
    return 1;
  }

  const oldId = cfg.anon_id;
  cfg.anon_id = crypto.randomUUID();
  config.save(cfg);

  await request(config.apiUrl(cfg), 'POST', '/v1/publisher/devices', {
    apiKey: cfg.api_key,
    body: { anon_id: cfg.anon_id, platform: platform(), sdk_version: SDK_VERSION },
  });

  console.log(`${c.green('✓')} anon_id rotated ${c.dim(`(${oldId ? oldId.slice(0, 8) + '…' : 'none'} → ${cfg.anon_id.slice(0, 8)}…)`)}`);
  console.log(`  new device registered · full ID: ${c.dim(cfg.anon_id)}`);
  return 0;
};

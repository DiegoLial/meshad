#!/usr/bin/env node
'use strict';

/**
 * meshad — command dispatcher.
 * Exit codes: 0 ok · 1 runtime error · 2 usage error.
 */

const { c, SDK_VERSION } = require('../src/util');
const i18n = require('../src/i18n');

i18n.init(require('../src/config').load());

const COMMANDS = {
  init: { mod: 'init', desc: 'Opt in, register with the network and create this device' },
  status: { mod: 'status', desc: 'Config, device, cached pack, earnings (--explain: last telemetry batch, byte for byte)' },
  earnings: { mod: 'earnings', desc: 'Show earnings (total / pending / available, per day)' },
  balance: { mod: 'stats', desc: 'Balance summary: total / pending / available' },
  stats: { mod: 'stats', desc: 'Impressions, clicks, CTR and earnings' },
  payout: { mod: 'payout', desc: 'Request a payout: meshad payout <method> <usd>' },
  verify: { mod: 'verify', desc: 'Verify the integrity and privacy of this installation' },
  pause: { mod: 'pause', desc: 'Pause ads: meshad pause [1h|1d|forever]' },
  resume: { mod: 'pause', desc: 'Resume ads' },
  config: { mod: 'configcmd', desc: 'Read/write config: meshad config [key] [value]' },
  'rotate-id': { mod: 'rotate', desc: 'Generate a new anon_id and re-register the device' },
  report: { mod: 'report', desc: 'Report an ad: meshad report <ad_id>' },
  demo: { mod: 'demo', desc: 'Simulate an AI agent thinking and exercise the full ad flow' },
  run: { mod: 'run', desc: 'Wrap a command: meshad run -- <cmd> (idle = output silence > 1.5s)' },
  uninstall: { mod: 'uninstall', desc: 'Remove all local MeshAd data' },
};

function usage() {
  const lines = [
    '',
    `  ${c.bold('meshad')} ${c.dim(`v${SDK_VERSION}`)} — ${i18n.t('usage.tagline')}`,
    '',
    '  Usage: meshad <command> [options]',
    '',
    ...Object.entries(COMMANDS).map(([name, { desc }]) => `    ${name.padEnd(12)} ${c.dim(desc)}`),
    '',
    `  ${c.dim('Every command accepts --help. Docs: docs/12-implementation/CONTRACT.md')}`,
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(usage());
    process.exit(cmd ? 0 : 2);
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(SDK_VERSION);
    process.exit(0);
  }

  const entry = COMMANDS[cmd];
  if (!entry) {
    console.error(`${c.red('error:')} ${i18n.t('usage.unknown', { cmd })}`);
    console.error(usage());
    process.exit(2);
  }

  const run = require(`../src/commands/${entry.mod}`);
  try {
    const code = await run(cmd, argv.slice(1));
    process.exit(typeof code === 'number' ? code : 0);
  } catch (err) {
    console.error(`${c.red('error:')} ${err.message}`);
    process.exit(1);
  }
}

main();

'use strict';

const config = require('../config');
const { c, parseFlags } = require('../util');

const HELP = `
  meshad report <ad_id> — report an ad

  Records the report locally (reports.json in your config dir). The
  reference API (v0.1) has no report endpoint yet — reports are kept
  locally and will be forwarded to the moderation queue once the
  endpoint ships. This is documented in CONTRACT.md.
`;

module.exports = async function report(_cmd, argv) {
  const { flags, rest } = parseFlags(argv, { help: 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }

  const adId = rest[0];
  if (!adId) {
    console.error(`${c.red('error:')} usage: meshad report <ad_id>`);
    return 2;
  }
  if (!/^ad_[A-Za-z0-9]{8,32}$/.test(adId)) {
    console.error(`${c.red('error:')} "${adId}" does not look like an ad id (ad_XXXXXXXX)`);
    return 2;
  }

  const reports = config.readJson('reports.json', []);
  reports.push({ ad_id: adId, reported_at: new Date().toISOString() });
  config.writeJson('reports.json', reports);

  console.log(`${c.green('✓')} report recorded for ${adId}`);
  console.log(c.dim('  Stored locally (reports.json). The MVP API has no report endpoint yet;'));
  console.log(c.dim('  reports will be forwarded to the moderation queue when it ships.'));
  return 0;
};

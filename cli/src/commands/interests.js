'use strict';

const readline = require('node:readline/promises');
const config = require('../config');
const i18n = require('../i18n');
const interests = require('../interests');
const { c, parseFlags } = require('../util');

const HELP = `
  meshad interests — optional, local-only dev/AI headlines while you wait

  Usage:
    meshad interests                          (in a terminal) pick topics interactively
    meshad interests edit                     same as above (alias: pick)
    meshad interests add <topic...> [--yes]   declare topics (asks consent the first time)
    meshad interests list                     show your topics and status (alias: show)
    meshad interests remove <topic...>        drop topics
    meshad interests clear                    wipe topics + consent + the headline cache
    meshad interests enable [--yes]           show headlines in \`meshad run\`
    meshad interests disable                  stop showing headlines (keeps topics)
    meshad interests topics                   list every valid topic

  Interests are stored only in <config dir>/interests.json (0600) and never
  leave this machine. Everything is OFF by default.
`;

function consentText(t, dir) {
  return `
  ${c.bold(t('interests.consent.title'))}

    1. ${t('interests.consent.local', { file: `${dir}/interests.json` })}
    2. ${t('interests.consent.feed')}
    3. ${t('interests.consent.nothing')}
    4. ${t('interests.consent.revoke', { disable: c.bold('meshad interests disable'), clear: c.bold('meshad interests clear') })}
`;
}

/**
 * Make sure the user consented. Returns 'ok' | 'declined' | 'usage' (non-TTY without --yes).
 * Writes nothing itself; the caller persists consented_at only on 'ok'.
 */
async function ensureConsent(state, flags, dir, t) {
  if (state.consented_at) return 'ok';
  console.log(consentText(t, dir));
  if (flags.yes) {
    console.log(c.dim(`  ${t('interests.acceptedNonInteractive')}`));
    return 'ok';
  }
  if (!process.stdin.isTTY) {
    console.error(`${c.red('error:')} ${t('interests.needYes')}`);
    return 'usage';
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`  ${t('interests.accept')}`);
    if (!i18n.isYes(answer)) {
      console.log(c.dim(`  ${t('interests.declined')}`));
      return 'declined';
    }
  } finally {
    rl.close();
  }
  return 'ok';
}

function parseTopics(rest, t) {
  if (rest.length === 0) {
    console.error(`${c.red('error:')} ${t('interests.needTopics')}`);
    return null;
  }
  const v = interests.validateTopics(rest);
  if (!v.ok) {
    console.error(`${c.red('error:')} ${t('interests.unknownTopic', { topics: v.unknown.join(', ') })}`);
    console.error(`  ${t('interests.validTopics')} ${interests.TAXONOMY.join(', ')}`);
    return null;
  }
  return v.topics;
}

function printState(state, t) {
  const status = !state.consented_at ? c.dim(t('interests.statusNoConsent')) : state.enabled ? c.green(t('interests.statusOn')) : c.yellow(t('interests.statusOff'));
  console.log('');
  console.log(`  ${c.bold(t('interests.title'))} — ${status}`);
  console.log(state.topics.length ? `    ${state.topics.join(', ')}` : `    ${c.dim(t('interests.none'))}`);
  console.log('');
}

module.exports = async function interestsCmd(_cmd, argv) {
  const cfg = config.load();
  i18n.init(cfg);
  const { t } = i18n;
  const { flags, rest } = parseFlags(argv, { yes: 'bool', help: 'bool' });
  const sub = rest[0];
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
  const interactive = sub === 'edit' || sub === 'pick' || (!sub && !flags.help && tty);
  if (!interactive && (flags.help || !sub || sub === 'help')) {
    console.log(HELP);
    return sub || flags.help ? 0 : 2;
  }
  const dir = config.configDir();
  if (interactive) {
    if (!tty) {
      console.error(`${c.red('error:')} ${t('interests.needTty')}`);
      return 2;
    }
    // consent (first time) → searchable topic picker; nothing is written before consent
    const next = await require('../onboarding').setupNews({ dir, stdin: process.stdin, stdout: process.stdout });
    printState(next, t);
    return 0;
  }
  const args = rest.slice(1);
  const state = interests.loadInterests(dir);

  switch (sub) {
    case 'topics':
      console.log(interests.TAXONOMY.join('\n'));
      return 0;

    case 'list':
    case 'show':
      printState(state, t);
      return 0;

    case 'add': {
      const topics = parseTopics(args, t);
      if (!topics) return 2;
      const consent = await ensureConsent(state, flags, dir, t);
      if (consent === 'usage') return 2;
      if (consent === 'declined') return 0;
      const next = interests.addTopics({ ...state, consented_at: state.consented_at || new Date().toISOString() }, topics);
      // Adding topics is what the user came here for: turn the feature on with the first consent.
      if (!state.consented_at) next.enabled = true;
      interests.saveInterests(dir, next);
      console.log(`  ${c.green('✓')} ${t('interests.added', { topics: topics.join(', ') })}`);
      if (next.enabled) console.log(c.dim(`  ${t('interests.nowOn')}`));
      return 0;
    }

    case 'remove': {
      const topics = parseTopics(args, t);
      if (!topics) return 2;
      interests.saveInterests(dir, interests.removeTopics(state, topics));
      console.log(`  ${c.green('✓')} ${t('interests.removed', { topics: topics.join(', ') })}`);
      return 0;
    }

    case 'clear':
      interests.clearInterests(dir);
      console.log(`  ${c.green('✓')} ${t('interests.cleared')}`);
      return 0;

    case 'enable': {
      const consent = await ensureConsent(state, flags, dir, t);
      if (consent === 'usage') return 2;
      if (consent === 'declined') return 0;
      interests.saveInterests(dir, { ...state, consented_at: state.consented_at || new Date().toISOString(), enabled: true });
      console.log(`  ${c.green('✓')} ${t('interests.enabled')}`);
      if (state.topics.length === 0) console.log(c.dim(`  ${t('interests.enabledNoTopics')}`));
      return 0;
    }

    case 'disable':
      interests.saveInterests(dir, { ...state, enabled: false });
      console.log(`  ${c.green('✓')} ${t('interests.disabled')}`);
      return 0;

    default:
      console.error(`${c.red('error:')} ${t('interests.unknownSub', { sub })}`);
      console.log(HELP);
      return 2;
  }
};

module.exports.consentText = consentText; // reused by the onboarding / menu consent step

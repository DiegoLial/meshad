'use strict';

/**
 * First-run onboarding + the shared news-setup step used by the menu.
 *
 * Runs only on an interactive terminal and only until `onboarding_done` is
 * set. Everything stays local: play_mode lives in config.json, interests in
 * interests.json (0600) — nothing is sent anywhere. The news consent text is
 * the same one `meshad interests` shows.
 */

const config = require('./config');
const i18n = require('./i18n');
const interests = require('./interests');
const { selectPrompt, multiSelectPrompt } = require('./menu');
const { consentText } = require('./commands/interests');
const { c } = require('./util');

/** Consent (if not yet given) → topic picker → persist. Returns the saved interests state. */
async function setupNews({ dir, stdin, stdout }) {
  const { t } = i18n;
  const out = stdout || process.stdout;
  let state = interests.loadInterests(dir);

  if (!state.consented_at) {
    out.write(`${consentText(t, dir)}\n`);
    const choice = await selectPrompt({
      title: t('onb.consent.title'),
      options: [
        { value: 'accept', label: t('onb.consent.accept') },
        { value: 'skip', label: t('onb.consent.skip') },
      ],
      stdin,
      stdout,
    });
    if (choice !== 'accept') return state; // nothing written without consent
    state = { ...state, consented_at: new Date().toISOString() };
  }

  const picked = await multiSelectPrompt({
    title: t('onb.topics.title'),
    subtitle: t('onb.topics.subtitle'),
    options: interests.TAXONOMY.map((value) => ({ value, label: value })),
    selected: state.topics,
    stdin,
    stdout,
  });
  const topics = picked === null ? state.topics : picked;
  state = { ...state, topics, enabled: topics.length > 0 };
  interests.saveInterests(dir, state);
  return state;
}

/**
 * @returns {Promise<boolean>} true when onboarding ran (and was saved)
 * Esc on the games question counts as "ask later"; Esc on the news question as "no".
 */
async function maybeRunOnboarding({ dir, cfg, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!(stdin && stdin.isTTY && stdout && stdout.isTTY) || cfg.onboarding_done) return false;
  const { t } = i18n;
  dir = dir || config.configDir();

  stdout.write(`\n  ${c.bold(t('onb.welcome'))}\n\n`);

  const play = await selectPrompt({
    title: t('onb.play.title'),
    subtitle: t('onb.play.subtitle'),
    options: [
      { value: 'yes', label: t('onb.play.yes'), hint: t('onb.play.yes.hint') },
      { value: 'no', label: t('onb.play.no'), hint: t('onb.play.no.hint') },
      { value: 'ask_later', label: t('onb.play.later'), hint: t('onb.play.later.hint') },
    ],
    stdin,
    stdout,
  });

  const news = await selectPrompt({
    title: t('onb.news.title'),
    subtitle: t('onb.news.subtitle'),
    options: [
      { value: 'yes', label: t('onb.news.yes') },
      { value: 'no', label: t('onb.news.no') },
    ],
    initialIndex: 1,
    stdin,
    stdout,
  });

  if (news === 'yes') {
    await setupNews({ dir, stdin, stdout });
  } else {
    const state = interests.loadInterests(dir);
    if (state.enabled) interests.saveInterests(dir, { ...state, enabled: false });
  }

  cfg.play_mode = play || 'ask_later';
  cfg.onboarding_done = true;
  config.save(cfg);
  i18n.init(cfg);
  stdout.write(`  ${c.green('✓')} ${i18n.t('onb.done')}\n\n`);
  return true;
}

module.exports = { maybeRunOnboarding, setupNews };

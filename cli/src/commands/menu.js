'use strict';

/**
 * meshad (bare) / meshad menu — interactive home menu. TTY only; the bare
 * `meshad` dispatcher keeps printing usage when there is no terminal.
 */

const config = require('../config');
const i18n = require('../i18n');
const interests = require('../interests');
const { selectPrompt } = require('../menu');
const { maybeRunOnboarding, setupNews } = require('../onboarding');
const { c } = require('../util');

const LANGS = [
  { value: 'auto', label: () => i18n.t('menu.val.auto') },
  { value: 'en', label: () => 'English' },
  { value: 'pt-BR', label: () => 'Português (Brasil)' },
];

function playModeLabel(mode) {
  const { t } = i18n;
  return mode === 'yes' ? t('onb.play.yes') : mode === 'no' ? t('onb.play.no') : mode === 'ask_later' ? t('onb.play.later') : t('menu.val.notSet');
}

async function settingsMenu(io) {
  const { t } = i18n;
  const dir = config.configDir();
  let last = 0;
  for (;;) {
    const cfg = config.load();
    const state = interests.loadInterests(dir);
    const newsOn = interests.isNewsActive(state);
    const langValue = cfg.lang || 'auto';
    const pick = await selectPrompt({
      title: t('menu.set.title'),
      initialIndex: last,
      options: [
        { value: 'play', label: t('menu.set.playMode'), hint: playModeLabel(cfg.play_mode) },
        { value: 'news', label: t('menu.set.news'), hint: newsOn ? t('menu.val.on') : t('menu.val.off') },
        { value: 'topics', label: t('menu.set.topics'), hint: state.topics.length ? `${state.topics.length}` : t('menu.val.notSet') },
        { value: 'lang', label: t('menu.set.lang'), hint: langValue === 'auto' ? t('menu.val.auto') : langValue },
        { value: 'back', label: t('menu.back') },
      ],
      ...io,
    });
    if (pick === null || pick === 'back') return;
    last = ['play', 'news', 'topics', 'lang'].indexOf(pick);

    if (pick === 'play') {
      const mode = await selectPrompt({
        title: t('menu.set.playMode.title'),
        options: [
          { value: 'yes', label: t('onb.play.yes'), hint: t('onb.play.yes.hint') },
          { value: 'no', label: t('onb.play.no'), hint: t('onb.play.no.hint') },
          { value: 'ask_later', label: t('onb.play.later'), hint: t('onb.play.later.hint') },
        ],
        initialIndex: Math.max(0, ['yes', 'no', 'ask_later'].indexOf(cfg.play_mode)),
        ...io,
      });
      if (mode) {
        cfg.play_mode = mode;
        config.save(cfg);
      }
    } else if (pick === 'news') {
      if (state.enabled) {
        interests.saveInterests(dir, { ...state, enabled: false });
      } else if (state.consented_at && state.topics.length > 0) {
        interests.saveInterests(dir, { ...state, enabled: true });
      } else {
        const next = await setupNews({ dir, ...io });
        if (next.consented_at && next.topics.length === 0) console.log(c.dim(`  ${t('menu.news.needTopics')}`));
      }
    } else if (pick === 'topics') {
      await setupNews({ dir, ...io });
    } else if (pick === 'lang') {
      const lang = await selectPrompt({
        title: t('menu.set.lang.title'),
        options: LANGS.map((l) => ({ value: l.value, label: l.label() })),
        initialIndex: Math.max(0, LANGS.findIndex((l) => l.value === langValue)),
        ...io,
      });
      if (lang) {
        cfg.lang = lang === 'auto' ? null : lang;
        config.save(cfg);
        i18n.init(cfg);
      }
    }
  }
}

/** Interests home: pick topics, switch headlines on/off, or wipe everything (with a confirmation). */
async function interestsMenu(io) {
  const { t } = i18n;
  const dir = config.configDir();
  let last = 0;
  for (;;) {
    const state = interests.loadInterests(dir);
    const on = interests.isNewsActive(state);
    const pick = await selectPrompt({
      title: t('menu.int.title'),
      subtitle: t('menu.int.subtitle', { n: state.topics.length, status: on ? t('menu.val.on') : t('menu.val.off') }),
      initialIndex: last,
      options: [
        { value: 'edit', label: t('menu.int.edit'), hint: state.topics.length ? t('menu.int.count', { n: state.topics.length }) : t('menu.val.notSet') },
        { value: 'toggle', label: on || state.enabled ? t('menu.int.turnOff') : t('menu.int.turnOn'), hint: on ? t('menu.val.on') : t('menu.val.off') },
        { value: 'clear', label: t('menu.int.clear'), hint: t('menu.int.clear.hint'), disabled: !state.consented_at && state.topics.length === 0 },
        { value: 'back', label: t('menu.back') },
      ],
      ...io,
    });
    if (pick === null || pick === 'back') return;
    last = ['edit', 'toggle', 'clear'].indexOf(pick);

    if (pick === 'edit') await setupNews({ dir, ...io });
    else if (pick === 'toggle') {
      if (state.enabled) interests.saveInterests(dir, { ...state, enabled: false });
      else if (state.consented_at && state.topics.length > 0) interests.saveInterests(dir, { ...state, enabled: true });
      else await setupNews({ dir, ...io }); // needs consent and/or topics first
    } else if (pick === 'clear') {
      const sure = await selectPrompt({
        title: t('menu.int.clear.confirm'),
        options: [{ value: 'no', label: t('menu.int.clear.no') }, { value: 'yes', label: t('menu.int.clear.yes') }],
        ...io,
      });
      if (sure === 'yes') interests.clearInterests(dir);
    }
  }
}

module.exports = async function menuCmd() {
  const io = { stdin: process.stdin, stdout: process.stdout };
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    console.error(`${c.red('error:')} ${i18n.t('menu.needTty')}`);
    return 1;
  }

  await maybeRunOnboarding({ dir: config.configDir(), cfg: config.load(), ...io });

  let last = 0;
  for (;;) {
    i18n.init(config.load());
    const { t } = i18n;
    const pick = await selectPrompt({
      title: t('menu.title'),
      subtitle: t('menu.subtitle'),
      initialIndex: last,
      options: [
        { value: 'play', label: t('menu.play'), hint: t('menu.play.hint') },
        { value: 'news', label: t('menu.news'), hint: t('menu.news.hint') },
        { value: 'interests', label: t('menu.interests'), hint: t('menu.interests.hint') },
        { value: 'settings', label: t('menu.settings'), hint: t('menu.settings.hint') },
        { value: 'status', label: t('menu.status'), hint: t('menu.status.hint') },
        { value: 'quit', label: t('menu.quit') },
      ],
      ...io,
    });
    if (pick === null || pick === 'quit') return 0;
    last = ['play', 'news', 'interests', 'settings', 'status'].indexOf(pick);

    if (pick === 'play') await require('./play')('play', []);
    else if (pick === 'news') await require('../news-view').showNews({ fetch: true, ...io });
    else if (pick === 'interests') await interestsMenu(io);
    else if (pick === 'settings') await settingsMenu(io);
    else if (pick === 'status') await require('./status')('status', []);
  }
};

module.exports.interestsMenu = interestsMenu;

'use strict';

/**
 * meshad play [runner|termo|snake|flappy|blocks|slide|chess] — a tiny terminal game for the time your agent
 * spends thinking. Separate process, its own TTY (alternate screen): it never
 * reads or forwards the agent's stdin. Talks to `meshad run --play` only
 * through the state file in the config dir (see play/bridge.js).
 *
 * Run on its own it is free-play: no telemetry, no impression, no network.
 * The one exception is the explicit leaderboard opt-in (`--join-leaderboard`):
 * until the player joins, ../leaderboard is never even loaded.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const i18n = require('../i18n');
const { c, parseFlags } = require('../util');
const { PlaySession, GAMES } = require('../play/session');
const { runTty } = require('../play/ui');
const { findSkinAd, loadSkin, skinAccent } = require('../play/skin');
const streaks = require('../play/streak');
const bridge = require('../play/bridge');
const { selectPrompt, textPrompt } = require('../menu');

const HANDLE_RE = /^[A-Za-z0-9_-]{3,16}$/; // same rule as ../leaderboard, kept here so it stays unloaded until opt-in

const HELP = `
  meshad play [runner|termo|snake|flappy|blocks|slide|chess] — a small game for while your agent thinks

  Games:
    runner   Wait Runner: dino-style, one key (Space) to jump, short sessions
    termo    Termo Dev: guess today's 5-letter developer word in 6 tries
    snake    Snake: eat, grow, don't hit a wall or yourself
    flappy   Flappy Term: flap through the gaps in the pipes
    blocks   Meshad Blocks: stack falling pieces, clear lines (next piece + ghost)
    slide    Slide 2048: merge equal tiles on a 4x4 board
    chess    Daily Mate: today's mate-in-N puzzle, 3 lives (type moves like e2e4 or Nf3)

  Same day, same seed: everyone gets the same word, obstacles, pieces and puzzle.
  When a game ends you get a share string to copy (text only, no links).

  Run it in a second terminal pane/tab. It watches \`meshad run --play\`:
  the game freezes while your agent is answering and resumes when it goes
  back to thinking. Press Space while frozen to keep playing anyway
  (free-play). Started on its own it is always free-play: no telemetry,
  nothing is sent, nothing is billed.

  Options:
    --help        show this help
    --join-leaderboard <handle>
                  opt in to the public leaderboard under a nickname. Finished
                  games are then sent as seed date + inputs + score; the server
                  replays them. No account, device id or e-mail is attached.
                  The handle token stays in leaderboard.json in the config dir.
    --leave-leaderboard
                  forget the handle locally and delete it (and its scores) on
                  the server
    --no-submit   play without sending this game's score
    --ad <id>     (used by \`meshad run --play\`) sponsored skin from the local
                  ad cache; its signature is re-verified before drawing

  Keys (Esc or Ctrl+C always quits, R restarts, P pauses the real-time games):
    runner   Space jump
    termo    letters · Enter submit · Backspace
    snake    arrows / WASD / hjkl turn
    flappy   Space or Up flap
    blocks   Left/Right move · Up or X rotate · Z rotate back · Down soft drop · Space hard drop
             (WASD / hjkl work too)
    slide    arrows / WASD / hjkl slide the tiles (Esc banks your score)
    chess    type a move (e2e4, e7e8q, Nf3, O-O) · Enter · Backspace
    While the game is frozen (your agent is answering): Space = keep playing
`;

module.exports = async function play(_cmd, argv) {
  const { flags, rest } = parseFlags(argv, { help: 'bool', ad: 'string', 'join-leaderboard': 'string', 'leave-leaderboard': 'bool', 'no-submit': 'bool' });
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  if (flags['join-leaderboard'] !== undefined || flags['leave-leaderboard']) return leaderboardCommand(flags);
  const unknownFlag = rest.find((a) => a.startsWith('-'));
  if (unknownFlag || rest.length > 1) {
    console.error(`${c.red('error:')} ${unknownFlag ? `unknown option "${unknownFlag}"` : 'too many arguments'} — usage: meshad play [${GAMES.join('|')}]`);
    return 2;
  }
  const game = rest[0] || null;
  if (game && !GAMES.includes(game)) {
    console.error(`${c.red('error:')} ${i18n.t('play.unknownGame', { game, games: GAMES.join(', ') })}`);
    return 2;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`${c.red('error:')} ${i18n.t('play.needTty')}`);
    return 1;
  }

  const dir = config.configDir();
  if (!game) return playMenu({ dir, flags });
  await playGame(game, { dir, flags });
  return 0;
};

/** Run one game in the alternate screen, then print the share string and submit the score. */
async function playGame(game, { dir, flags }) {
  const skinLines = game && flags.ad
    ? loadSkin({ dir, adId: flags.ad, game, cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
    : [];
  const skinAd = game && flags.ad ? findSkinAd({ dir, adId: flags.ad, game }) : null;
  const session = new PlaySession({ game, dir, skinLines, skinAccent: skinAccent(skinAd) });
  // Tell `meshad run` when this pane is really drawing (local file, see play/bridge.js).
  const renderSignal = {
    beat: () => bridge.writeRender(dir, Date.now(), process.env.TMUX_PANE || null),
    clear: () => bridge.clearRender(dir),
  };
  await runTty(session, { renderSignal });

  // Back on the normal screen: leave the share string in the scrollback to copy.
  if (session.shareText) {
    const card = session.shareCardLines();
    console.log(`\n${card.length ? `${card.join('\n')}\n\n` : ''}${i18n.t('play.share.title')}\n${session.shareText}\n`);
  }
  if (session.result && !flags['no-submit']) await submitResult(session.result, dir);
}

/** Interactive game picker: stays open after each game / leaderboard action; Back, Esc or Ctrl-C leaves. */
async function playMenu({ dir = config.configDir(), flags = {}, stdin, stdout, runGame = playGame } = {}) {
  const io = { stdin, stdout };
  let last = 0;
  for (;;) {
    const { t } = i18n;
    // Only touch the leaderboard module when a handle file already exists (explicit opt-in).
    const me = fs.existsSync(path.join(dir, 'leaderboard.json')) ? require('../leaderboard').load(dir) : null;
    const stats = streaks.load(dir);
    const today = new Date().toISOString().slice(0, 10);
    const statHint = (game, base) => {
      const e = stats[game];
      const live = streaks.liveStreak(e, today);
      return [base, e.best > 0 ? t('play.pick.stats', { best: e.best }) : '', live > 0 ? t('play.pick.streak', { n: live }) : ''].filter(Boolean).join(' · ');
    };
    const options = [
      ...GAMES.map((g) => ({ value: g, label: t(`play.pick.${g}`), hint: statHint(g, t(`play.pick.${g}.hint`)) })),
      me
        ? { value: 'join', label: t('play.pick.change'), hint: t('play.pick.change.hint', { handle: me.handle }) }
        : { value: 'join', label: t('play.pick.join'), hint: t('play.pick.join.hint') },
      { value: 'leave', label: t('play.pick.leave'), hint: t('play.pick.leave.hint'), disabled: !me },
      { value: 'news', label: t('play.pick.news'), hint: t('play.pick.news.hint') },
      { value: 'back', label: t('menu.back') },
    ];
    const pick = await selectPrompt({ title: t('play.pick.title'), subtitle: t('play.pick.subtitle'), options, initialIndex: last, ...io });
    if (pick === null || pick === 'back') return 0;
    last = options.findIndex((o) => o.value === pick);

    if (GAMES.includes(pick)) {
      await runGame(pick, { dir, flags });
    } else if (pick === 'news') {
      await require('../news-view').showNews({ dir, fetch: false, ...io }); // play stays offline: cache only
    } else if (pick === 'join') {
      const handle = await textPrompt({
        title: t('play.pick.nick.title'),
        placeholder: t('play.pick.nick.placeholder'),
        validate: (v) => (HANDLE_RE.test(v) ? null : t('play.lb.badHandle')),
        ...io,
      });
      if (handle === null) continue;
      try {
        const r = await require('../leaderboard').join(handle, { dir });
        console.log(i18n.t('play.lb.joined', { handle: r.handle }));
      } catch (e) {
        const reason = e.status === 409 ? i18n.t('play.lb.taken') : e.message;
        console.error(`${c.red('error:')} ${i18n.t('play.lb.joinFailed', { reason })}`);
      }
    } else if (pick === 'leave') {
      const r = await require('../leaderboard').leave({ dir });
      console.log(r.left ? i18n.t(r.remoteDeleted ? 'play.lb.left' : 'play.lb.leftLocalOnly') : i18n.t('play.lb.notJoined'));
    }
  }
}

/** Opt-in leaderboard: join / leave. Needs no TTY. */
async function leaderboardCommand(flags) {
  const lb = require('../leaderboard');
  if (flags['leave-leaderboard']) {
    const r = await lb.leave();
    console.log(r.left ? i18n.t(r.remoteDeleted ? 'play.lb.left' : 'play.lb.leftLocalOnly') : i18n.t('play.lb.notJoined'));
    return 0;
  }
  const handle = flags['join-leaderboard'];
  if (!lb.HANDLE_RE.test(String(handle))) {
    console.error(`${c.red('error:')} ${i18n.t('play.lb.badHandle')}`);
    return 2;
  }
  try {
    const r = await lb.join(handle);
    console.log(i18n.t('play.lb.joined', { handle: r.handle }));
    return 0;
  } catch (e) {
    const reason = e.status === 409 ? i18n.t('play.lb.taken') : e.message;
    console.error(`${c.red('error:')} ${i18n.t('play.lb.joinFailed', { reason })}`);
    return 1;
  }
}

/** After a game: send it only when the player has joined. Never throws, never prints the token. */
async function submitResult(result, dir) {
  const lb = require('../leaderboard');
  if (!lb.load(dir)) return;
  try {
    const r = await lb.submit(result, { dir });
    console.log(i18n.t('play.lb.submitted', { score: r.score, handle: r.handle, best: r.best }));
  } catch (e) {
    console.error(i18n.t('play.lb.submitFailed', { reason: e.code || e.message }));
  }
}

module.exports.playMenu = playMenu;
module.exports.submitResult = submitResult; // exported for tests (no TTY needed)

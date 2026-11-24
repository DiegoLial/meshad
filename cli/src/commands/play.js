'use strict';

/**
 * meshad play [runner|termo] — a tiny terminal game for the time your agent
 * spends thinking. Separate process, its own TTY (alternate screen): it never
 * reads or forwards the agent's stdin. Talks to `meshad run --play` only
 * through the state file in the config dir (see play/bridge.js).
 *
 * Run on its own it is free-play: no telemetry, no impression, no network.
 * The one exception is the explicit leaderboard opt-in (`--join-leaderboard`):
 * until the player joins, ../leaderboard is never even loaded.
 */

const config = require('../config');
const i18n = require('../i18n');
const { c, parseFlags } = require('../util');
const { PlaySession, GAMES } = require('../play/session');
const { runTty } = require('../play/ui');
const { loadSkin } = require('../play/skin');
const bridge = require('../play/bridge');

const HELP = `
  meshad play [runner|termo] — a small game for while your agent thinks

  Games:
    runner   Wait Runner: dino-style, one key (Space) to jump, short sessions
    termo    Termo Dev: guess today's 5-letter developer word in 6 tries

  Same day, same seed: everyone gets the same word and the same obstacles.
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

  Keys: Space = jump / keep playing · P pause (runner) · Esc or Ctrl+C quit
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
  const skinLines = game && flags.ad
    ? loadSkin({ dir, adId: flags.ad, game, cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
    : [];
  const session = new PlaySession({ game, dir, skinLines });
  // Tell `meshad run` when this pane is really drawing (local file, see play/bridge.js).
  const renderSignal = {
    beat: () => bridge.writeRender(dir, Date.now(), process.env.TMUX_PANE || null),
    clear: () => bridge.clearRender(dir),
  };
  await runTty(session, { renderSignal });

  // Back on the normal screen: leave the share string in the scrollback to copy.
  if (session.shareText) {
    console.log(`\n${i18n.t('play.share.title')}\n${session.shareText}\n`);
  }
  if (session.result && !flags['no-submit']) await submitResult(session.result, dir);
  return 0;
};

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

module.exports.submitResult = submitResult; // exported for tests (no TTY needed)

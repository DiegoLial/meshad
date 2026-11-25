'use strict';

/**
 * Full-width "cards": the freeze card shown when the agent's answer lands, and
 * the share card printed when a game ends. Pure (style, numbers) → lines.
 * Share cards are text only — no links, no ids, nothing that tracks.
 */

const { MAX_TICKS } = require('./runner');
const { gradientBox } = require('./box');
const { displayWidth } = require('../creative');

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** The sponsor row as a box line. Too wide for the card: drop its HEAD (content) and keep the tail, where the "sponsored" label is. */
function sponsorRows(sponsor, cols) {
  if (!sponsor) return [];
  const plain = sponsor.replace(ANSI_RE, '');
  const room = Math.max(8, cols - 7); // box border + padding
  if (displayWidth(plain) <= room) return [{ text: sponsor, plain }];
  let tail = plain;
  while (tail && displayWidth(`…${tail}`) > room) tail = tail.slice(1);
  return [{ text: `…${tail}`, plain: `…${tail}` }];
}

/**
 * The "your answer is ready" card, centred in a `cols` × `rows` area. One key goes back to
 * the agent (Esc / Enter / Q, handled by PlaySession), Space keeps playing. Plain glyphs only
 * inside the box (✓, ★ — no emoji, no letter-spacing) so the right border lines up everywhere.
 * `sponsor` is an optional one-line verified sponsor row (already styled, already carries "sponsored"):
 * it sits under the title, inside the card, and is kept whole (its tail holds the label) if the card is narrow.
 */
function freezeCard({ style, cols, rows, game, score, best, streak = 0, sponsor = '', t }) {
  const title = `✓  ${t('play.freeze.title')}`;
  const stats = t('play.freeze.score', { score, best });
  const streakLine = streak > 0 ? t('play.freeze.streak', { n: streak }) : '';
  const back = t('play.freeze.back');
  const cont = t('play.freeze.continue');
  const row = (text, plain, opts) => ({ text: style.paint(text, opts), plain });
  const inner = [
    { text: '', plain: '' },
    { text: style.gradient(title, 'lime', 'cyan', { bold: true }), plain: title },
    ...sponsorRows(sponsor, cols), // directly under the title
    row(game, game, { fg: 'mute' }),
    { text: '', plain: '' },
    row(stats, stats, { fg: 'ink', bold: true }),
    ...(streakLine ? [row(streakLine, streakLine, { fg: 'amber', bold: true })] : []),
    { text: '', plain: '' },
    row(back, back, { fg: 'lime', bold: true }),
    row(cont, cont, { fg: 'amber' }),
    { text: '', plain: '' },
  ];
  const card = gradientBox({ style, inner, maxWidth: Math.max(20, cols - 2), from: 'lime', to: 'cyan', bg: 'panel' });
  const pad = Math.max(0, Math.floor((cols - 1 - (card.width || 0)) / 2));
  const top = Math.max(0, Math.floor((rows - card.lines.length) / 2));
  return [...Array(top).fill(''), ...card.lines.map((l) => ' '.repeat(pad) + l)];
}

const TILE_EMOJI = { G: '🟩', Y: '🟨', B: '⬛' };
const TILE_COLOR = { G: 'green', Y: 'gold', B: 'slate' };

/**
 * End-of-game card. Termo: spoiler-free tile grid + streak. Runner: distance bar.
 * The newer games (snake, flappy, blocks, slide, chess) pass `share`, the same copy string the
 * player gets to paste: first line is the title, the rest is the card body.
 * @param {{style:object, game:string, date:string, state:object, share?:string, score?:number, streak?:number, best?:number, newBest?:boolean, t:Function}} o
 */
function shareCard({ style, game, date, state, share = '', score = 0, streak = 0, best = 0, newBest = false, t }) {
  const body = [];
  let title;
  if (share) {
    const [head, ...rest] = share.split('\n');
    title = head;
    for (const line of rest) body.push({ text: style.paint(line, { fg: newBest ? 'lime' : 'ink', bold: true }), plain: line });
    if (game !== 'chess' && score > 0) {
      const width = 20;
      const filled = Math.max(1, Math.round((score / Math.max(best, score, 1)) * width));
      body.push({ text: style.paint('▰'.repeat(filled), { fg: newBest ? 'lime' : 'cyan' }) + style.paint('▱'.repeat(width - filled), { fg: 'line' }), plain: '▰'.repeat(filled) + '▱'.repeat(width - filled) });
    }
    if (newBest) body.push({ text: style.paint(t('play.share.newBest'), { fg: 'lime', bold: true }), plain: t('play.share.newBest') });
  } else if (game === 'termo') {
    title = `Termo Dev ${date} ${state.won ? state.guesses.length : 'X'}/6`;
    for (const marks of state.marks) {
      const row = marks.map((m) => (style.on ? style.paint('██', { fg: TILE_COLOR[m] }) : TILE_EMOJI[m])).join(style.on ? ' ' : '');
      body.push({ text: row, plain: marks.map((m) => (style.on ? '██' : TILE_EMOJI[m])).join(style.on ? ' ' : '') });
    }
  } else {
    title = `Wait Runner ${date}`;
    const width = 20;
    const scale = Math.max(best, state.score, 1);
    const filled = Math.max(state.score > 0 ? 1 : 0, Math.round((state.score / scale) * width));
    const bar = style.paint('▰'.repeat(filled), { fg: newBest ? 'lime' : 'cyan' }) + style.paint('▱'.repeat(width - filled), { fg: 'line' });
    const label = `🏃 ${state.score}m${newBest ? `  ${t('play.share.newBest')}` : ''}`;
    body.push({ text: `${bar}`, plain: '▰'.repeat(filled) + '▱'.repeat(width - filled) });
    body.push({ text: style.paint(label, { fg: newBest ? 'lime' : 'ink', bold: true }), plain: label });
    const cap = `${state.score} / ${MAX_TICKS}`;
    body.push({ text: style.paint(cap, { fg: 'mute', dim: true }), plain: cap });
  }
  const inner = [
    { text: style.paint(title, { fg: 'ink', bold: true }), plain: title },
    { text: '', plain: '' },
    ...body,
  ];
  if (streak > 0) {
    const s = `🔥 ${t('play.share.streak', { n: streak })}`;
    inner.push({ text: '', plain: '' }, { text: style.paint(s, { fg: 'amber', bold: true }), plain: s });
  }
  return gradientBox({ style, inner, maxWidth: 60, from: 'magenta', to: 'cyan', bg: null, align: 'left' }).lines;
}

module.exports = { freezeCard, shareCard };

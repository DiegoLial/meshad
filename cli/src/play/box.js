'use strict';

/** Rounded box with a gradient border around pre-styled lines. Shared by the freeze and share cards. */

const { displayWidth, truncateToWidth } = require('../creative');

/**
 * @param {{style:object, inner:Array<{text:string, plain:string}>, maxWidth:number, from:string, to:string,
 *          bg?:string|null, align?:'center'|'left'}} o   `plain` is the unstyled text, used only to measure.
 * @returns {{lines:string[], width:number}}
 */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function gradientBox({ style, inner, maxWidth, from, to, bg = null, align = 'center' }) {
  // Measure what is really drawn: the styled text with its escapes stripped, falling back to `plain`
  // only when they disagree on a clip. A `plain` that drifted from `text` is what pushed the right border out of line.
  const widthOf = (l) => Math.max(displayWidth(l.plain), displayWidth(l.text.replace(ANSI_RE, '')));
  const contentW = Math.max(...inner.map(widthOf), 0);
  const innerW = Math.min(Math.max(contentW + 4, 24), Math.max(8, maxWidth - 2));
  const edge = (s) => style.gradient(s, from, to);
  const fill = (s) => (bg ? style.paint(s, { bg }) : s);
  const lines = [edge(`╭${'─'.repeat(innerW)}╮`)];
  for (const l of inner) {
    const w = widthOf(l);
    const clipped = w > innerW - 2 ? truncateToWidth(l.plain, innerW - 2) : null;
    const text = clipped !== null ? clipped : l.text;
    const tw = clipped !== null ? displayWidth(clipped) : w;
    const left = align === 'center' ? Math.floor((innerW - tw) / 2) : 1;
    const right = innerW - tw - left;
    lines.push(`${edge('│')}${fill(' '.repeat(left))}${bg && style.on ? `${style.open({ bg })}${text.replace(/\x1b\[0m/g, `\x1b[0m${style.open({ bg })}`)}\x1b[0m` : text}${fill(' '.repeat(right))}${edge('│')}`);
  }
  lines.push(edge(`╰${'─'.repeat(innerW)}╯`));
  return { lines, width: innerW + 2 };
}

module.exports = { gradientBox };

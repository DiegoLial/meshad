'use strict';

/**
 * Daily chess mate puzzle. Pure: the puzzle comes from the UTC date seed, and a
 * compact legal move generator (castling, en passant, promotion, check / mate
 * detection) does all the rule work from a FEN.
 *
 * Puzzles: chess-puzzles.json, from the Lichess puzzle database
 * (Source: database.lichess.org, CC0). Lichess format: `fen` is the position
 * BEFORE the opponent's move; moves[0] is that opponent move, then the player's
 * solution alternates with forced replies. The list is append-only: reordering
 * or removing one changes which puzzle every date maps to.
 *
 * Rules: moves are entered as coordinate (e2e4, e7e8q) or simple SAN (Nf3,
 * exd5, O-O, e8=Q). Any legal move that delivers checkmate solves the puzzle,
 * even when it differs from the listed one. Any other legal move that is not
 * the listed one is a mistake; MAX_MISTAKES mistakes end the game. Illegal or
 * unparsable input is not a mistake (state untouched).
 * Score: solved ? MAX_MISTAKES - mistakes : 0  (3 = flawless … 1; max MAX_SCORE).
 *
 * Log format: state.log — the accepted moves in coordinate form, e.g. ['d1h5'].
 */

const { seedFor, makeRng } = require('./rng');
const DATA = require('./chess-puzzles.json');

const PUZZLES = DATA.puzzles;
const MAX_MISTAKES = 3;
const MAX_SCORE = MAX_MISTAKES;
/** Longest log the server will replay: the longest solution plus every mistake. */
const MAX_LOG = 12;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const FILES = 'abcdefgh';
const sqName = (i) => FILES[i & 7] + (8 - (i >> 3));
const sqIdx = (s) => (8 - Number(s[1])) * 8 + FILES.indexOf(s[0]);
const colorOf = (p) => (p < 'a' ? 'w' : 'b');
const other = (c) => (c === 'w' ? 'b' : 'w');

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ---------------------------------------------------------------- position

function parseFen(fen) {
  const [placement, turn = 'w', castle = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
  const board = Array(64).fill(null);
  placement.split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else board[r * 8 + f++] = ch;
    }
  });
  return { board, turn, castle: castle === '-' ? '' : castle, ep: ep === '-' ? -1 : sqIdx(ep), half: Number(half), full: Number(full) };
}

function toFen(pos) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let s = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 8 + f];
      if (p) { if (empty) s += empty; empty = 0; s += p; } else empty += 1;
    }
    rows.push(s + (empty || ''));
  }
  return `${rows.join('/')} ${pos.turn} ${pos.castle || '-'} ${pos.ep < 0 ? '-' : sqName(pos.ep)} ${pos.half} ${pos.full}`;
}

/** Is `sq` attacked by any piece of colour `by`? */
function attacked(board, sq, by) {
  const f = sq & 7;
  const r = sq >> 3;
  const at = (nf, nr) => (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 ? board[nr * 8 + nf] : null);
  const pawn = by === 'w' ? 'P' : 'p';
  const pr = by === 'w' ? r + 1 : r - 1;
  if (at(f - 1, pr) === pawn || at(f + 1, pr) === pawn) return true;
  const kn = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of KNIGHT) if (at(f + df, r + dr) === kn) return true;
  const kg = by === 'w' ? 'K' : 'k';
  for (const [df, dr] of KING) if (at(f + df, r + dr) === kg) return true;
  const q = by === 'w' ? 'Q' : 'q';
  const bi = by === 'w' ? 'B' : 'b';
  const ro = by === 'w' ? 'R' : 'r';
  for (const [dirs, slider] of [[DIAG, bi], [ORTH, ro]]) {
    for (const [df, dr] of dirs) {
      for (let nf = f + df, nr = r + dr; nf >= 0 && nf < 8 && nr >= 0 && nr < 8; nf += df, nr += dr) {
        const p = board[nr * 8 + nf];
        if (p) { if (p === q || p === slider) return true; break; }
      }
    }
  }
  return false;
}

function kingSquare(board, color) {
  return board.indexOf(color === 'w' ? 'K' : 'k');
}

function inCheck(pos, color = pos.turn) {
  const k = kingSquare(pos.board, color);
  return k >= 0 && attacked(pos.board, k, other(color));
}

/** Pseudo-legal moves (may leave the own king in check). */
function pseudoMoves(pos) {
  const { board, turn } = pos;
  const moves = [];
  const add = (from, to, extra = {}) => moves.push({ from, to, promo: '', flag: '', ...extra });
  for (let from = 0; from < 64; from++) {
    const p = board[from];
    if (!p || colorOf(p) !== turn) continue;
    const f = from & 7;
    const r = from >> 3;
    const t = p.toLowerCase();
    const onBoard = (nf, nr) => nf >= 0 && nf < 8 && nr >= 0 && nr < 8;
    if (t === 'p') {
      const dr = turn === 'w' ? -1 : 1;
      const startRank = turn === 'w' ? 6 : 1;
      const lastRank = turn === 'w' ? 1 : 6; // rank index from which a push promotes
      const push = (to, flag = '') => {
        if (r === lastRank) for (const promo of 'qrbn') add(from, to, { promo });
        else add(from, to, { flag });
      };
      if (onBoard(f, r + dr) && !board[(r + dr) * 8 + f]) {
        push((r + dr) * 8 + f);
        if (r === startRank && !board[(r + 2 * dr) * 8 + f]) add(from, (r + 2 * dr) * 8 + f, { flag: 'dbl' });
      }
      for (const df of [-1, 1]) {
        if (!onBoard(f + df, r + dr)) continue;
        const to = (r + dr) * 8 + f + df;
        if (board[to] && colorOf(board[to]) !== turn) push(to);
        else if (to === pos.ep) add(from, to, { flag: 'ep' });
      }
    } else if (t === 'n' || t === 'k') {
      for (const [df, dr] of t === 'n' ? KNIGHT : KING) {
        if (!onBoard(f + df, r + dr)) continue;
        const to = (r + dr) * 8 + f + df;
        if (!board[to] || colorOf(board[to]) !== turn) add(from, to);
      }
      if (t === 'k') castlingMoves(pos, from, add);
    } else {
      const dirs = t === 'b' ? DIAG : t === 'r' ? ORTH : [...DIAG, ...ORTH];
      for (const [df, dr] of dirs) {
        for (let nf = f + df, nr = r + dr; onBoard(nf, nr); nf += df, nr += dr) {
          const to = nr * 8 + nf;
          if (!board[to]) { add(from, to); continue; }
          if (colorOf(board[to]) !== turn) add(from, to);
          break;
        }
      }
    }
  }
  return moves;
}

function castlingMoves(pos, from, add) {
  const { board, turn } = pos;
  const home = turn === 'w' ? 60 : 4;
  if (from !== home || pos.castle === '' || inCheck(pos)) return;
  const foe = other(turn);
  const rook = turn === 'w' ? 'R' : 'r';
  const [ks, qs] = turn === 'w' ? ['K', 'Q'] : ['k', 'q'];
  if (pos.castle.includes(ks) && board[home + 3] === rook && !board[home + 1] && !board[home + 2]
    && !attacked(board, home + 1, foe) && !attacked(board, home + 2, foe)) add(from, home + 2, { flag: 'castle' });
  if (pos.castle.includes(qs) && board[home - 4] === rook && !board[home - 1] && !board[home - 2] && !board[home - 3]
    && !attacked(board, home - 1, foe) && !attacked(board, home - 2, foe)) add(from, home - 2, { flag: 'castle' });
}

/** Play a (pseudo-)legal move; returns a new position, the input is untouched. */
function makeMove(pos, m) {
  const board = pos.board.slice();
  const piece = board[m.from];
  const captured = board[m.to];
  board[m.to] = m.promo ? (pos.turn === 'w' ? m.promo.toUpperCase() : m.promo) : piece;
  board[m.from] = null;
  if (m.flag === 'ep') board[m.to + (pos.turn === 'w' ? 8 : -8)] = null;
  if (m.flag === 'castle') {
    const kingside = m.to > m.from;
    board[kingside ? m.from + 1 : m.from - 1] = board[kingside ? m.from + 3 : m.from - 4];
    board[kingside ? m.from + 3 : m.from - 4] = null;
  }
  let castle = pos.castle;
  const strip = (chars) => { for (const c of chars) castle = castle.replace(c, ''); };
  if (piece === 'K') strip('KQ');
  if (piece === 'k') strip('kq');
  for (const [sq, c] of [[56, 'Q'], [63, 'K'], [0, 'q'], [7, 'k']]) if (m.from === sq || m.to === sq) strip(c);
  return {
    board,
    turn: other(pos.turn),
    castle,
    ep: m.flag === 'dbl' ? (m.from + m.to) / 2 : -1,
    half: piece.toLowerCase() === 'p' || captured ? 0 : pos.half + 1,
    full: pos.full + (pos.turn === 'b' ? 1 : 0),
  };
}

function legalMoves(pos) {
  return pseudoMoves(pos).filter((m) => !inCheck(makeMove(pos, m), pos.turn));
}

const isCheckmate = (pos) => inCheck(pos) && legalMoves(pos).length === 0;
const isStalemate = (pos) => !inCheck(pos) && legalMoves(pos).length === 0;

/** Perft node count — the standard move-generator check. */
function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(makeMove(pos, m), depth - 1);
  return n;
}

// ------------------------------------------------------------- move text

const uci = (m) => sqName(m.from) + sqName(m.to) + m.promo;

function toSan(pos, m, legal = legalMoves(pos)) {
  const piece = pos.board[m.from].toUpperCase();
  let s;
  if (m.flag === 'castle') s = m.to > m.from ? 'O-O' : 'O-O-O';
  else {
    const capture = pos.board[m.to] || m.flag === 'ep';
    if (piece === 'P') s = (capture ? FILES[m.from & 7] + 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo.toUpperCase() : '');
    else {
      const rivals = legal.filter((o) => o !== m && o.to === m.to && pos.board[o.from] === pos.board[m.from]);
      let dis = '';
      if (rivals.length) {
        if (!rivals.some((o) => (o.from & 7) === (m.from & 7))) dis = FILES[m.from & 7];
        else if (!rivals.some((o) => (o.from >> 3) === (m.from >> 3))) dis = String(8 - (m.from >> 3));
        else dis = sqName(m.from);
      }
      s = piece + dis + (capture ? 'x' : '') + sqName(m.to);
    }
  }
  const after = makeMove(pos, m);
  if (inCheck(after)) s += legalMoves(after).length === 0 ? '#' : '+';
  return s;
}

const normSan = (s) => s.replace(/[+#!?x=]/g, '').replace(/0/g, 'O');

/** Find the legal move for coordinate ('e2e4', 'e7e8q') or simple SAN ('Nf3', 'exd5', 'O-O'); null if none. */
function parseMove(pos, text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  const legal = legalMoves(pos);
  const c = t.toLowerCase();
  if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(c)) return legal.find((m) => uci(m) === c) || null;
  const want = normSan(t);
  if (!want) return null;
  return legal.find((m) => normSan(toSan(pos, m, legal)) === want) || null;
}

// ----------------------------------------------------------------- puzzle

/** The puzzle of the day for a UTC date (YYYY-MM-DD). */
function dailyPuzzle(date) {
  return PUZZLES[makeRng(seedFor(date, 'chess')).int(PUZZLES.length)];
}

/** Position after the opponent's first move (the one the player sees). */
function puzzleStart(puzzle) {
  const pos = parseFen(puzzle.fen);
  const first = parseMove(pos, puzzle.moves[0]);
  return { pos: makeMove(pos, first), first };
}

function fromPuzzle(puzzle, date = null) {
  const { pos, first } = puzzleStart(puzzle);
  return {
    date, puzzle: { id: puzzle.id, rating: puzzle.rating, themes: puzzle.themes },
    pos, lastMove: uci(first), solution: puzzle.moves.slice(1), idx: 0,
    mateIn: Math.ceil((puzzle.moves.length - 1) / 2),
    mistakes: 0, solved: false, over: false, log: [],
  };
}

function create(date) {
  return fromPuzzle(dailyPuzzle(date), date);
}

/**
 * Enter a move. Returns {ok:false, reason} for 'over' | 'unparsable' | 'illegal' (state untouched), else
 * {ok:true, result} with result 'solved' | 'correct' | 'mistake' | 'failed'.
 */
function play(state, text) {
  if (state.over) return { ok: false, reason: 'over' };
  const m = parseMove(state.pos, text);
  if (!m) {
    const looksLike = typeof text === 'string' && text.trim() !== '';
    return { ok: false, reason: looksLike && /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(text.trim()) ? 'illegal' : 'unparsable' };
  }
  const move = uci(m);
  const after = makeMove(state.pos, m);
  state.log.push(move);
  if (isCheckmate(after)) {
    state.pos = after;
    state.lastMove = move;
    state.solved = true;
    state.over = true;
    return { ok: true, result: 'solved', move };
  }
  if (move === state.solution[state.idx]) {
    state.pos = after;
    state.lastMove = move;
    const reply = state.solution[state.idx + 1];
    state.idx += 2;
    if (reply) {
      state.pos = makeMove(state.pos, parseMove(state.pos, reply));
      state.lastMove = reply;
    }
    return { ok: true, result: 'correct', move, reply: reply || null };
  }
  state.mistakes += 1;
  if (state.mistakes >= MAX_MISTAKES) state.over = true;
  return { ok: true, result: state.over ? 'failed' : 'mistake', move };
}

function score(state) {
  return state.solved ? MAX_MISTAKES - state.mistakes : 0;
}

/** Replay a log from scratch. `rejected` counts entries that were illegal, unparsable or after the end. */
function replay(date, log) {
  const state = create(date);
  let rejected = 0;
  for (const text of log) if (!play(state, text).ok) rejected += 1;
  return { score: score(state), over: state.over, solved: state.solved, mistakes: state.mistakes, rejected };
}

function shareString(state) {
  const mark = state.solved ? `${score(state)}/${MAX_SCORE}` : 'X';
  return `Mate Puzzle ${state.date} ${mark}\n${'🟥'.repeat(state.mistakes)}${state.solved ? '🟩' : ''}`;
}

module.exports = {
  START_FEN, MAX_MISTAKES, MAX_SCORE, MAX_LOG, PUZZLES,
  parseFen, toFen, legalMoves, makeMove, inCheck, isCheckmate, isStalemate, perft, uci, toSan, parseMove,
  dailyPuzzle, puzzleStart, fromPuzzle, create, play, score, replay, shareString,
};

'use strict';

/**
 * tmux helpers for `meshad run --play`. The split is opened with `-d` so focus
 * stays in the agent's pane: nothing the user types is ever redirected to the
 * game (or the other way round) unless they switch panes themselves.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', '..', 'bin', 'meshad.js');

const shq = (s) => (/^[A-Za-z0-9_\/:=.,@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** Are we inside tmux with a usable `tmux` binary? */
function available({ env = process.env, run = spawnSync } = {}) {
  if (!env.TMUX) return false;
  const r = run('tmux', ['-V'], { stdio: 'ignore', timeout: 1500 });
  return !!r && r.status === 0;
}

/** Shell command line the new pane runs. The pane inherits tmux's env, not ours, so pass what matters. */
function playCommand({ dir, game, adId, env = process.env, node = process.execPath, bin = BIN }) {
  const pass = [`MESHAD_CONFIG_DIR=${dir}`];
  if (env.MESHAD_LANG) pass.push(`MESHAD_LANG=${env.MESHAD_LANG}`);
  const args = ['play', ...(game ? [game] : []), ...(adId ? ['--ad', adId] : [])];
  return ['env', ...pass, node, bin, ...args].map(shq).join(' ');
}

/**
 * Open `meshad play` in a new split (detached focus). Returns the pane id, or
 * null when tmux refused — callers must treat null as "no game shown".
 */
function openSplit({ dir, game, adId, env = process.env, run = spawnSync }) {
  const r = run(
    'tmux',
    ['split-window', '-d', '-h', '-P', '-F', '#{pane_id}', playCommand({ dir, game, adId, env })],
    { encoding: 'utf8', timeout: 1500 },
  );
  if (!r || r.status !== 0) return null;
  const id = String(r.stdout || '').trim();
  return /^%\d+$/.test(id) ? id : null;
}

/** Is that pane still open? */
function paneAlive(paneId, { run = spawnSync } = {}) {
  if (!paneId) return false;
  const r = run('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8', timeout: 1500 });
  return !!r && r.status === 0 && String(r.stdout || '').split('\n').includes(paneId);
}

/**
 * What tmux says about the split's window. Null when it cannot be asked (tmux
 * missing/erroring, pane gone, unparsable) — callers must treat null as "not
 * visible". Facts only: no focus requirement is applied here.
 */
function paneInfo(paneId, { run = spawnSync } = {}) {
  if (!paneId) return null;
  const fmt = '#{pane_id} #{pane_dead} #{pane_active} #{window_active} #{window_zoomed_flag} #{session_attached}';
  const r = run('tmux', ['display-message', '-p', '-t', paneId, fmt], { encoding: 'utf8', timeout: 500 });
  if (!r || r.status !== 0) return null;
  const f = String(r.stdout || '').trim().split(' ');
  if (f.length !== 6 || f[0] !== paneId || !f.slice(1).every((x) => /^\d+$/.test(x))) return null;
  return {
    dead: f[1] === '1',
    paneActive: f[2] === '1',
    windowActive: f[3] === '1',
    zoomed: f[4] === '1',
    attached: Number(f[5]),
  };
}

/**
 * `prefix + j` (Ctrl+B J): open `meshad play` in a horizontal split, or focus the
 * one that is already alive (found through the render signal's pane id). Runs
 * inside tmux's run-shell, never inside the wrapped agent. Returns the pane id
 * or null. Best-effort: never throws.
 */
function openOrFocus({ dir, env = process.env, run = spawnSync, readRender } = {}) {
  try {
    const render = (readRender || require('./bridge').readRender)(dir);
    if (render && render.pane && paneAlive(render.pane, { run })) {
      run('tmux', ['select-pane', '-t', render.pane], { timeout: 1500 });
      return render.pane;
    }
    const r = run(
      'tmux',
      ['split-window', '-h', '-P', '-F', '#{pane_id}', playCommand({ dir, env })],
      { encoding: 'utf8', timeout: 1500 },
    );
    if (!r || r.status !== 0) return null;
    const id = String(r.stdout || '').trim();
    return /^%\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Bind `prefix + j` to openOrFocus. tmux key tables are server-wide, so when the
 * session id is known the binding only acts in OUR session (other sessions fall
 * through to whatever `j` did before). The previous binding is remembered and put
 * back by unbindPlayKey. Best-effort: returns a handle (or null), never throws.
 */
function bindPlayKey({ dir, env = process.env, run = spawnSync, node = process.execPath } = {}) {
  try {
    const ask = (args, input) => run('tmux', args, { encoding: 'utf8', timeout: 1500, input });
    const prevOut = ask(['list-keys', '-T', 'prefix', 'j']);
    const prevLine = prevOut && prevOut.status === 0 ? String(prevOut.stdout || '').split('\n')[0].trim() : '';
    const m = /^bind-key\s+(?:-r\s+)?-T\s+prefix\s+j\s+(.+)$/.exec(prevLine);
    const sidOut = ask(['display-message', '-p', '#{session_id}']);
    const sid = sidOut && sidOut.status === 0 ? String(sidOut.stdout || '').trim() : '';

    const script = [node, __filename, 'open-or-focus', dir].map(shq).join(' ');
    const action = `run-shell -b ${shq(script)}`;
    const args = /^\$\d+$/.test(sid)
      ? ['bind-key', '-T', 'prefix', 'j', 'if-shell', '-F', `#{==:#{session_id},${sid}}`, action, ...(m ? [m[1]] : [])]
      : ['bind-key', '-T', 'prefix', 'j', 'run-shell', '-b', script];
    const r = ask(args);
    if (!r || r.status !== 0) return null;
    return { prev: m ? prevLine : null };
  } catch {
    return null;
  }
}

/** Undo bindPlayKey: restore the previous `prefix j` binding, or just unbind. Never throws. */
function unbindPlayKey(handle, { run = spawnSync } = {}) {
  if (!handle) return;
  try {
    if (handle.prev) {
      const r = run('tmux', ['source-file', '-'], { encoding: 'utf8', timeout: 1500, input: handle.prev + '\n' });
      if (r && r.status === 0) return;
    }
    run('tmux', ['unbind-key', '-T', 'prefix', 'j'], { stdio: 'ignore', timeout: 1500 });
  } catch { /* best effort */ }
}

module.exports = { paneInfo, available, playCommand, openSplit, paneAlive, openOrFocus, bindPlayKey, unbindPlayKey, shq };

if (require.main === module && process.argv[2] === 'open-or-focus' && process.argv[3]) {
  openOrFocus({ dir: process.argv[3] });
}

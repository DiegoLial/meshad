'use strict';

/**
 * Opt-in leaderboard client. The ONLY networked piece next to `meshad play`,
 * and it is inert until the player runs `meshad play --join-leaderboard <handle>`.
 * All traffic goes through api.js → net.js (host allowlist applies).
 *
 * Local state: <configDir>/leaderboard.json {handle, token}, mode 0600. The
 * token is a secret that proves ownership of the public handle; it is never
 * printed, logged or put in an error message. Only seed date + input log +
 * declared score go to the server (it replays them) — nothing about the device.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { request } = require('./api');

const FILE = 'leaderboard.json';
const HANDLE_RE = /^[A-Za-z0-9_-]{3,16}$/;

function load(dir = config.configDir()) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return typeof j.handle === 'string' && typeof j.token === 'string' && j.token ? { handle: j.handle, token: j.token } : null;
  } catch {
    return null;
  }
}

/** Register a handle (explicit opt-in) and keep its token locally. Throws on failure. */
async function join(handle, { dir = config.configDir(), apiUrl = config.apiUrl(config.load()) } = {}) {
  if (!HANDLE_RE.test(String(handle))) {
    const e = new Error('bad handle');
    e.code = 'bad_handle';
    throw e;
  }
  const res = await request(apiUrl, 'POST', '/v1/games/handles', { body: { handle, opt_in: true } });
  config.writeFileAtomic(dir, FILE, JSON.stringify({ handle: res.handle, token: res.token }, null, 2) + '\n');
  return { handle: res.handle };
}

/** Forget the handle locally and ask the server to delete it and its scores. Server errors don't block the local leave. */
async function leave({ dir = config.configDir(), apiUrl = config.apiUrl(config.load()) } = {}) {
  const me = load(dir);
  if (!me) return { left: false, remoteDeleted: false };
  let remoteDeleted = true;
  try {
    await request(apiUrl, 'DELETE', '/v1/games/handles/me', { apiKey: me.token });
  } catch {
    remoteDeleted = false;
  }
  fs.rmSync(path.join(dir, FILE), { force: true });
  return { left: true, remoteDeleted };
}

/** Send one finished game's replay. `result` is PlaySession#result. Throws on failure. */
async function submit(result, { dir = config.configDir(), apiUrl = config.apiUrl(config.load()) } = {}) {
  const me = load(dir);
  if (!me) return null;
  return request(apiUrl, 'POST', '/v1/games/scores', {
    apiKey: me.token,
    body: { game: result.game, date: result.date, score: result.score, log: result.log },
  });
}

module.exports = { load, join, leave, submit, HANDLE_RE, FILE };

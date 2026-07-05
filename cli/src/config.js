'use strict';

/**
 * Config store — $MESHAD_CONFIG_DIR (default ~/.config/meshad)/config.json
 * Human-readable JSON, file mode 0600, dir mode 0700. Never obfuscated.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  api_url: 'http://localhost:4000',
  api_key: null,
  account_id: null,
  anon_id: null,
  paused_until: null, // null | 'forever' | epoch ms (number)
  frequency_cap_h: 6,
  min_wait_ms: 8000,
  terminal_type_default: 'other',
  lang: null, // null = auto (MESHAD_LANG → LANG env); or 'en' | 'pt-BR'
};

const CONFIG_KEYS = Object.keys(DEFAULTS);

function configDir() {
  return process.env.MESHAD_CONFIG_DIR || path.join(os.homedir(), '.config', 'meshad');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function exists() {
  return fs.existsSync(configPath());
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(cfg) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath();
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // writeFileSync mode is ignored if the file already exists
  } catch {
    /* best effort on platforms without chmod */
  }
}

/** Effective API base URL: env var wins over config (per CONTRACT.md). */
function apiUrl(cfg) {
  return process.env.MESHAD_API_URL || (cfg && cfg.api_url) || DEFAULTS.api_url;
}

/** Is ad display currently paused? */
function isPaused(cfg, now = Date.now()) {
  if (!cfg || cfg.paused_until == null) return false;
  if (cfg.paused_until === 'forever') return true;
  return now < Number(cfg.paused_until);
}

/** Generic sidecar JSON files inside the config dir (queue.json, cache.json, ...). */
function readJson(name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir(), name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

module.exports = {
  DEFAULTS,
  CONFIG_KEYS,
  configDir,
  configPath,
  exists,
  load,
  save,
  apiUrl,
  isPaused,
  readJson,
  writeJson,
};

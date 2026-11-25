'use strict';

/**
 * Config store — $MESHAD_CONFIG_DIR (default ~/.config/meshad)/config.json
 * Human-readable JSON, file mode 0600, dir mode 0700. Never obfuscated.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  // The public network. Local development overrides via MESHAD_API_URL (env
  // wins over config, see apiUrl()) — a public install must never default to
  // the user's own machine.
  api_url: 'https://api.meshad.io',
  api_key: null,
  account_id: null,
  anon_id: null,
  paused_until: null, // null | 'forever' | epoch ms (number)
  frequency_cap_h: 6,
  // Developer mode: no frequency cap and NO telemetry delivery — ads render
  // for integration testing but no impression is ever billed or credited.
  // Unlimited-and-earning would be an impression-farming exploit by design.
  dev_mode: false,
  min_wait_ms: 8000,
  terminal_type_default: 'other',
  lang: null, // null = auto (MESHAD_LANG → LANG env); or 'en' | 'pt-BR'
  // Easy-UX onboarding (see onboarding.js). play_mode: null (unanswered) | 'yes' | 'no' | 'ask_later'.
  play_mode: null,
  onboarding_done: false,
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

/**
 * Write `content` to <dir>/<name> atomically: tmp file in the same directory +
 * rename, so a concurrent reader (`meshad play` reading what `meshad run`
 * writes) sees the old file or the new one, never a torn half-write.
 */
function writeFileAtomic(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, name);
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

function writeJson(name, data) {
  writeFileAtomic(configDir(), name, JSON.stringify(data, null, 2) + '\n');
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
  writeFileAtomic,
};

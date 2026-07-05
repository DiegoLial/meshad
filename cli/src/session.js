'use strict';

/** Shared glue between `demo` and `run`: event building, cap window persistence. */

const config = require('./config');
const { SDK_VERSION } = require('./util');

const WINDOW_FILE = 'window.json';

/** Build a schema-conformant telemetry event (the ONLY shape we ever emit). */
function makeEvent(cfg, event, extra = {}) {
  return {
    event,
    ts: new Date().toISOString(),
    anon_id: cfg.anon_id,
    terminal_type: cfg.terminal_type_default,
    sdk_version: SDK_VERSION,
    ...extra,
  };
}

/** Persisted sliding window of impression timestamps (local frequency cap). */
function loadWindow() {
  const w = config.readJson(WINDOW_FILE, []);
  return Array.isArray(w) ? w : [];
}

function saveWindow(history) {
  config.writeJson(WINDOW_FILE, history);
}

/** Rough publisher take for one impression of `ad` (70% rev share). */
function estimateEarningsMicros(ad) {
  if (!ad) return 0;
  if (ad.pricing_model === 'cpm') return (ad.price_micros / 1000) * 0.7;
  return 0; // cpc pays on click, not on impression
}

module.exports = { makeEvent, loadWindow, saveWindow, estimateEarningsMicros, WINDOW_FILE };

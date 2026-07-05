/**
 * Vendored copy of packages/schema — the public data contract.
 *
 * The CLI must be installable standalone (`npm install -g` from a git
 * subdirectory, no monorepo checkout required), so it can't depend on
 * packages/schema via a `file:` path. This file and
 * packages/schema/index.js (plus their telemetry-schema.json) must stay
 * byte-identical — test/schema-sync.test.js enforces that.
 *
 * Zero-dependency validation of the closed telemetry allowlist.
 * Used by BOTH the client (before sending) and the gateway (on receipt),
 * so a payload outside the contract can never be produced nor accepted.
 */
'use strict';

const TELEMETRY_SCHEMA = require('./telemetry-schema.json');

const EVENT_TYPES = ['idle_start', 'idle_end', 'impression', 'click', 'heartbeat'];
const TERMINAL_TYPES = [
  'claude-code', 'gemini-cli', 'codex', 'aider', 'opencode',
  'cursor', 'windsurf', 'kiro', 'continue', 'other',
];
const ALLOWED_FIELDS = ['event', 'ts', 'anon_id', 'terminal_type', 'duration_ms', 'ad_id', 'sdk_version'];
const REQUIRED_FIELDS = ['event', 'ts', 'anon_id', 'terminal_type', 'sdk_version'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AD_ID_RE = /^ad_[A-Za-z0-9]{8,32}$/;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * Validate a single telemetry event against the closed allowlist.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateEvent(ev) {
  const errors = [];
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    return { ok: false, errors: ['event must be an object'] };
  }
  for (const key of Object.keys(ev)) {
    if (!ALLOWED_FIELDS.includes(key)) {
      errors.push(`field not in allowlist: ${key}`);
    }
  }
  for (const key of REQUIRED_FIELDS) {
    if (!(key in ev)) errors.push(`missing required field: ${key}`);
  }
  if (errors.length) return { ok: false, errors };

  if (!EVENT_TYPES.includes(ev.event)) errors.push(`invalid event type: ${ev.event}`);
  if (typeof ev.ts !== 'string' || Number.isNaN(Date.parse(ev.ts))) errors.push('ts must be an ISO-8601 timestamp');
  if (typeof ev.anon_id !== 'string' || !UUID_RE.test(ev.anon_id)) errors.push('anon_id must be a lowercase UUID');
  if (!TERMINAL_TYPES.includes(ev.terminal_type)) errors.push(`invalid terminal_type: ${ev.terminal_type}`);
  if (typeof ev.sdk_version !== 'string' || !SEMVER_RE.test(ev.sdk_version)) errors.push('sdk_version must be semver');

  if ('duration_ms' in ev) {
    if (!Number.isInteger(ev.duration_ms) || ev.duration_ms < 0 || ev.duration_ms > 86400000) {
      errors.push('duration_ms must be an integer in [0, 86400000]');
    }
    if (!['idle_end', 'impression'].includes(ev.event)) {
      errors.push(`duration_ms not allowed on event type: ${ev.event}`);
    }
  }
  if ('ad_id' in ev) {
    if (typeof ev.ad_id !== 'string' || !AD_ID_RE.test(ev.ad_id)) errors.push('ad_id has invalid format');
    if (!['impression', 'click'].includes(ev.event)) {
      errors.push(`ad_id not allowed on event type: ${ev.event}`);
    }
  }
  if (ev.event === 'impression' && !('ad_id' in ev)) errors.push('impression requires ad_id');
  if (ev.event === 'click' && !('ad_id' in ev)) errors.push('click requires ad_id');
  if (ev.event === 'idle_end' && !('duration_ms' in ev)) errors.push('idle_end requires duration_ms');

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a batch. The whole batch is rejected if ANY event is invalid —
 * an official client can never legitimately produce a partially valid batch.
 * @returns {{ ok: boolean, results: {ok: boolean, errors: string[]}[] }}
 */
function validateBatch(events) {
  if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
    return { ok: false, results: [], batchError: 'events must be an array of 1..100 items' };
  }
  const results = events.map(validateEvent);
  return { ok: results.every((r) => r.ok), results };
}

module.exports = {
  TELEMETRY_SCHEMA,
  SCHEMA_VERSION: '1.0.0',
  EVENT_TYPES,
  TERMINAL_TYPES,
  ALLOWED_FIELDS,
  REQUIRED_FIELDS,
  validateEvent,
  validateBatch,
};

'use strict';

/**
 * Telemetry pipeline — local queue with offline buffering.
 *
 * - Every event is validated against the schema module BEFORE enqueueing.
 *   An invalid event is a client bug, so enqueue() THROWS — the official
 *   client can never produce an out-of-contract payload.
 * - Queue persisted in <configDir>/queue.json; batches of max 100.
 * - flush() is fire-and-forget from the caller's perspective (flushSoon):
 *   3s request timeout, exponential retry up to 3 attempts, events are only
 *   removed from the queue after the server accepts them (202). Network
 *   failure keeps them buffered for the next flush.
 * - The exact bytes of the last batch sent are persisted in last-batch.json
 *   for `meshad status --explain`.
 * - NOTHING here ever blocks the render/clear path.
 */

const fs = require('node:fs');
const path = require('node:path');
const { validateEvent, validateBatch } = require('./schema');

const QUEUE_FILE = 'queue.json';
const LAST_BATCH_FILE = 'last-batch.json';
const MAX_BATCH = 100;

class Telemetry {
  constructor({
    dir,
    apiUrl,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    maxAttempts = 3,
    timeoutMs = 3000,
    backoffBaseMs = 500,
  }) {
    this.dir = dir;
    this.apiUrl = apiUrl;
    this.fetch = fetchImpl;
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.timeoutMs = timeoutMs;
    this.backoffBaseMs = backoffBaseMs;
    this.queue = this._readQueue();
    this._flushing = null;
  }

  _readQueue() {
    try {
      const q = JSON.parse(fs.readFileSync(path.join(this.dir, QUEUE_FILE), 'utf8'));
      return Array.isArray(q) ? q : [];
    } catch {
      return [];
    }
  }

  _writeJson(name, data) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', {
      mode: 0o600,
    });
  }

  _persistQueue() {
    this._writeJson(QUEUE_FILE, this.queue);
  }

  /**
   * Validate + enqueue a single event. Throws on any schema violation —
   * producing an invalid event is a bug, never a runtime condition.
   */
  enqueue(event) {
    const res = validateEvent(event);
    if (!res.ok) {
      throw new Error(`telemetry schema violation (client bug): ${res.errors.join('; ')}`);
    }
    this.queue.push(event);
    this._persistQueue();
  }

  get pending() {
    return this.queue.length;
  }

  /** Fire-and-forget flush — safe to call from anywhere, never throws. */
  flushSoon() {
    this.flush().catch(() => {});
  }

  /**
   * Send queued events in batches of ≤100. Serialized (concurrent calls share
   * one run). Resolves { sent, remaining }; never rejects on network errors.
   */
  async flush() {
    if (this._flushing) return this._flushing;
    this._flushing = this._flush().finally(() => {
      this._flushing = null;
    });
    return this._flushing;
  }

  async _flush() {
    let sent = 0;
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, MAX_BATCH);
      const check = validateBatch(batch);
      if (!check.ok) {
        // Should be unreachable: enqueue() already validated every event.
        throw new Error('telemetry queue contains an invalid batch (client bug)');
      }
      const body = JSON.stringify({ events: batch });
      const outcome = await this._send(body);
      if (outcome === 'accepted') {
        this.queue = this.queue.slice(batch.length);
        this._persistQueue();
        sent += batch.length;
      } else if (outcome === 'rejected') {
        // Server-side 4xx: retrying the same bytes can never succeed. Drop the
        // batch (this "cannot happen" with local validation) but keep going.
        this.queue = this.queue.slice(batch.length);
        this._persistQueue();
      } else {
        break; // network/5xx after retries: keep buffered for next flush
      }
    }
    return { sent, remaining: this.queue.length };
  }

  /** POST one batch with retries. → 'accepted' | 'rejected' | 'unreachable' */
  async _send(body) {
    const url = `${this.apiUrl}/v1/telemetry/events`;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const record = {
        url,
        sent_at: new Date(this.now()).toISOString(),
        attempt,
        body, // exact bytes on the wire — shown by `status --explain`
      };
      try {
        const res = await this.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        record.status = res.status;
        this._writeJson(LAST_BATCH_FILE, JSON.stringify(record, null, 2) + '\n');
        if (res.status === 202) return 'accepted';
        if (res.status >= 400 && res.status < 500) return 'rejected';
      } catch {
        record.status = 'network_error';
        try {
          this._writeJson(LAST_BATCH_FILE, JSON.stringify(record, null, 2) + '\n');
        } catch {
          /* ignore */
        }
      }
      if (attempt < this.maxAttempts) {
        await new Promise((r) => setTimeout(r, this.backoffBaseMs * 2 ** (attempt - 1)));
      }
    }
    return 'unreachable';
  }
}

module.exports = { Telemetry, QUEUE_FILE, LAST_BATCH_FILE, MAX_BATCH };

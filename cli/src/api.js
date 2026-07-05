'use strict';

/** Thin HTTP helper for the publisher API (CONTRACT.md). */

async function request(apiUrl, method, pathname, { body, apiKey, timeoutMs = 5000 } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${apiUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = json && json.error && json.error.code;
    throw err;
  }
  return json;
}

module.exports = { request };

'use strict';

/**
 * Open a headline in the system browser — fire-and-forget, local only (no network code here:
 * the browser, not meshad, fetches the page). The URL is re-validated and stripped of tracking
 * parameters right before it is handed to the OS.
 */

const { spawn } = require('node:child_process');

const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|yclid|si)$/i;

/** https URL without credentials and without tracking params (query or hash), or null. */
function cleanOpenUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  if (u.hash.length > 1) {
    const kept = u.hash.slice(1).split(/[&?]/).filter((seg) => !TRACKING_PARAM.test(seg.split('=')[0]));
    u.hash = kept.join('&');
  }
  return u.toString();
}

/** [command, args] that opens `url` on this OS. Never goes through a shell (no `&`/`^` re-parsing). */
function openCommand(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]]; // `cmd /c start` would re-parse `&` in the URL
  return ['xdg-open', [url]];
}

/**
 * Launch the browser detached and return immediately.
 * @returns {boolean} false when the URL is unsafe or the launcher could not be started
 */
function openUrl(raw, { platform = process.platform, spawnImpl = spawn } = {}) {
  const url = cleanOpenUrl(raw);
  if (!url) return false;
  const [cmd, args] = openCommand(url, platform);
  try {
    const child = spawnImpl(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    if (child && typeof child.on === 'function') child.on('error', () => {}); // missing launcher: never crash the view
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { cleanOpenUrl, openCommand, openUrl };

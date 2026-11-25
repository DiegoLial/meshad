'use strict';

/**
 * Local "read" marks for the headlines view: <configDir>/news-read.json (0600).
 *
 * Only a bounded list of opaque keys (the feed item id, or its cleaned URL) is stored — never
 * titles, never anything sent anywhere. `meshad interests clear` and `meshad uninstall` wipe it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./config');
const { cleanOpenUrl } = require('./news-open');

const FILE = 'news-read.json';
const MAX_KEYS = 500;

/** Stable key for an item: its feed id when it has one, else its tracking-free URL. null if neither. */
function readKey(item) {
  if (!item) return null;
  if (item.id) return `id:${item.id}`;
  const url = cleanOpenUrl(item.url);
  return url ? `url:${url}` : null;
}

/** Oldest → newest list of keys ([] when absent/corrupt). */
function loadRead(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    const keys = Array.isArray(raw && raw.read) ? raw.read.filter((k) => typeof k === 'string' && k.length <= 2100) : [];
    return [...new Set(keys)].slice(-MAX_KEYS);
  } catch {
    return [];
  }
}

function saveRead(dir, keys) {
  writeFileAtomic(dir, FILE, JSON.stringify({ read: [...new Set(keys)].slice(-MAX_KEYS) }, null, 2) + '\n');
}

/** Set `key` read (or unread) and persist; returns the new key list. Re-marking moves it to the newest slot. */
function setRead(dir, key, read) {
  if (!key) return loadRead(dir);
  const keys = loadRead(dir).filter((k) => k !== key);
  if (read) keys.push(key);
  saveRead(dir, keys);
  return keys.slice(-MAX_KEYS);
}

function clearRead(dir) {
  try { fs.unlinkSync(path.join(dir, FILE)); } catch { /* absent */ }
}

module.exports = { FILE, MAX_KEYS, readKey, loadRead, saveRead, setRead, clearRead };

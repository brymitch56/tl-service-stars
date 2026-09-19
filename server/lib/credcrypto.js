'use strict';
/**
 * At-rest encryption for the Trail Life Connect credentials and the signed-in
 * cookie jar. AES-256-GCM with a key kept in .env (CRED_KEY) — deliberately
 * OUTSIDE data/, so a database snapshot or a nightly backup holds only
 * ciphertext. A stolen backup no longer yields the portal password; only live
 * access to BOTH the database and .env does.
 *
 * The key is generated on first save and appended to .env. If .env is missing
 * or unwritable we throw rather than silently storing plaintext.
 */
const crypto = require('crypto');
const fs = require('fs');
const { ENV_PATH } = require('./env');

const KEY_VAR = 'CRED_KEY';

function loadKey() {
  const hex = process.env[KEY_VAR];
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

function ensureKey(envPath = ENV_PATH) {
  const existing = loadKey();
  if (existing) return existing;
  if (process.env[KEY_VAR]) throw new Error(`${KEY_VAR} in .env is malformed — it must be 64 hex characters.`);
  const key = crypto.randomBytes(32);
  const line = '\n# Auto-generated key that encrypts the stored Trail Life Connect password\n'
    + '# and session cookies at rest in the database. Keep it out of backups and git.\n'
    + '# Losing it means reconnecting the portal — nothing else.\n'
    + `${KEY_VAR}=${key.toString('hex')}\n`;
  fs.appendFileSync(envPath, line, { mode: 0o600 }); // append, never rewrite
  process.env[KEY_VAR] = key.toString('hex');
  return key;
}

function encrypt(plaintext, key = loadKey()) {
  if (!key) throw new Error('No credential-encryption key available.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** Plaintext, or null when the key is missing/rotated or the box was tampered with. */
function decrypt(box, key = loadKey()) {
  try {
    if (!key || !box || box.v !== 1) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { loadKey, ensureKey, encrypt, decrypt, ENV_PATH, KEY_VAR };

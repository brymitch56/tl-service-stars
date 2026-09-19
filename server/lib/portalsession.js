'use strict';
/**
 * portalsession.js — Trail Life Connect sign-in state that survives a
 * restart: the signed-in cookie jar, plus a code challenge waiting on a human.
 *
 * WHY THIS EXISTS. Trail Life Connect requires a second factor — a password
 * and a texted code at every sign-in. The nightly sync and any push both go
 * through one client (lib/tlc.js). If each posted the password on its own
 * schedule, each would strand on a code prompt with nobody there to answer.
 *
 * The design is CONNECT ONCE, MACHINE CONTINUES:
 *   1. A leader presses "Connect" in Settings (or a job runs, finds no usable
 *      session, and parks a challenge for the next human).
 *   2. The server posts the password; the portal answers with a code form.
 *      That form — action, field name, hidden inputs — and the
 *      half-authenticated cookie jar are parked here for CHALLENGE_TTL_MS.
 *   3. The human types the code off their phone into the settings page; the
 *      server finishes the sign-in and stores the resulting cookies.
 *   4. Every later job reuses those cookies and never sees a code prompt
 *      until the portal itself expires the session.
 *
 * DELIBERATELY NOT BUILT: automatic code retrieval. An unattended relay that
 * reads the code collapses two factors into one on an account that reaches
 * youth records — the machine would hold both the password and the code path.
 * A human typing six digits once per session lifetime is the entire security
 * value of the second factor, and it is the one part that must stay human.
 *
 * AT REST: cookies, the parked challenge and the portal password are all
 * credentials, so all three are AES-256-GCM encrypted through lib/credcrypto.
 * Every read tolerates a missing or rotated CRED_KEY by reporting "not
 * connected" rather than throwing; the worst case is one extra sign-in.
 */
const fs = require('fs');
const crypto = require('crypto');
const { db } = require('../db');
const credcrypto = require('./credcrypto');

const SESSION_KEY = 'portal_session';
const CHALLENGE_KEY = 'portal_challenge';
const CREDS_KEY = 'portal_credentials';
const CHALLENGE_TTL_MS = 15 * 60 * 1000;

// ------------------------------------------------------------- vault i/o ---
function readVault(key) {
  try {
    const row = db.prepare('SELECT value FROM vault WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}
function writeVault(key, obj) {
  db.prepare(`INSERT INTO vault (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(obj), new Date().toISOString());
}
const dropVault = (key) => db.prepare('DELETE FROM vault WHERE key = ?').run(key).changes > 0;

/** Encrypt a JSON payload, generating the key on first use. */
function seal(obj) {
  if (!credcrypto.loadKey()) {
    if (!fs.existsSync(credcrypto.ENV_PATH)) throw new Error('no CRED_KEY, and no .env file to store one in');
    credcrypto.ensureKey();
  }
  return credcrypto.encrypt(JSON.stringify(obj));
}
/** Decrypt, or null — never throws. */
function unseal(box) {
  if (!box) return null;
  let raw;
  try { raw = credcrypto.decrypt(box); } catch { return null; }
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------------------------------------------------------- credentials ----
/** Save the portal e-mail + password (admin action). */
function saveCredentials({ email, password }) {
  writeVault(CREDS_KEY, { email, box: seal({ password }) });
  return { email };
}
/** { email, password } or null. */
function loadCredentials() {
  const c = readVault(CREDS_KEY);
  if (!c) return null;
  const p = unseal(c.box);
  if (!p || !p.password) return null;
  return { email: c.email, password: p.password };
}
/** What the settings page renders — never the password. */
function credentialsInfo() {
  const c = readVault(CREDS_KEY);
  if (!c) return { saved: false, email: null, readable: false };
  return { saved: true, email: c.email || null, readable: !!unseal(c.box) };
}
const clearCredentials = () => ({ cleared: dropVault(CREDS_KEY) });

// ------------------------------------------------------ signed-in session --
/** Cookies are stored as plain "name=value" lines — what CookieJar takes. */
function saveCookies(jar, base) {
  const lines = typeof jar.lines === 'function' ? jar.lines() : jar;
  if (!lines || !lines.length) return null;
  const now = new Date().toISOString();
  const prev = readVault(SESSION_KEY) || {};
  try {
    writeVault(SESSION_KEY, {
      base,
      saved_at: now,
      last_ok_at: now,
      connected_at: prev.base === base && prev.connected_at ? prev.connected_at : now,
      box: seal({ lines }),
    });
  } catch (e) {
    // No CRED_KEY and no writable .env: keep working, just without a
    // persistent session (every job then needs its own code).
    console.error('[portal] could not store the portal session:', e.message);
    return null;
  }
  return now;
}

/** The stored cookie lines for this base, or null. */
function loadCookies(base) {
  const s = readVault(SESSION_KEY);
  if (!s || (base && s.base && s.base !== base)) return null;
  const payload = unseal(s.box);
  return payload && Array.isArray(payload.lines) && payload.lines.length ? payload.lines : null;
}

/** Called after a stored session is proven still good. */
function touch() {
  const s = readVault(SESSION_KEY);
  if (!s) return null;
  const now = new Date().toISOString();
  writeVault(SESSION_KEY, { ...s, last_ok_at: now });
  return now;
}

const clearSession = () => ({ cleared: dropVault(SESSION_KEY) });

/** Never includes cookies — this is what the settings page renders. */
function sessionInfo() {
  const s = readVault(SESSION_KEY);
  if (!s) {
    return { connected: false, base: null, connected_at: null, saved_at: null, last_ok_at: null, readable: false };
  }
  const readable = !!unseal(s.box);
  return {
    connected: readable,
    readable,
    base: s.base || null,
    connected_at: s.connected_at || s.saved_at || null,
    saved_at: s.saved_at || null,
    last_ok_at: s.last_ok_at || null,
  };
}

// -------------------------------------------------------- parked challenge --
// One at a time: a newer sign-in attempt replaces an older prompt, because
// the code the portal just sent is the only one that will work.
function putChallenge({ base, cookies, challenge, prompt }) {
  const id = crypto.randomBytes(9).toString('base64url');
  const created_at = new Date().toISOString();
  const expires_at = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  try {
    writeVault(CHALLENGE_KEY, { id, base, created_at, expires_at, prompt: prompt || null, box: seal({ cookies, challenge }) });
  } catch (e) {
    console.error('[portal] could not park the sign-in challenge:', e.message);
    return null;
  }
  return { id, created_at, expires_at, prompt: prompt || null };
}

/** Full record including cookies + form details. Expired or unreadable → null. */
function getChallenge(id) {
  const c = readVault(CHALLENGE_KEY);
  if (!c) return null;
  if (id && c.id !== id) return null;
  if (Date.parse(c.expires_at) < Date.now()) { dropVault(CHALLENGE_KEY); return null; }
  const payload = unseal(c.box);
  if (!payload) return null;
  return {
    id: c.id, base: c.base, created_at: c.created_at, expires_at: c.expires_at, prompt: c.prompt, ...payload,
  };
}

/** Safe summary for the settings page (no cookies, no form internals). */
function challengeInfo() {
  const c = readVault(CHALLENGE_KEY);
  if (!c) return null;
  if (Date.parse(c.expires_at) < Date.now()) { dropVault(CHALLENGE_KEY); return null; }
  return { id: c.id, created_at: c.created_at, expires_at: c.expires_at, prompt: c.prompt || null };
}

const clearChallenge = () => ({ cleared: dropVault(CHALLENGE_KEY) });

module.exports = {
  CHALLENGE_TTL_MS,
  saveCredentials, loadCredentials, credentialsInfo, clearCredentials,
  saveCookies, loadCookies, touch, clearSession, sessionInfo,
  putChallenge, getChallenge, challengeInfo, clearChallenge,
};

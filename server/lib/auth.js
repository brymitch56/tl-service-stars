'use strict';
/**
 * auth.js — leader sign-in with a real password.
 *
 * Passwords, not PINs: this app shows every trailman's service history and
 * can write to the troop's Trail Life Connect record, so a four-digit code
 * on a public URL is not enough.
 *
 * Hashing is Node's built-in scrypt (N=2^15, r=8, p=1 — ~100 ms and ~32 MB
 * per hash on a Pi 4, which is the point). No hashing dependency: adding one
 * to a public repo that a volunteer will deploy is a supply-chain surface
 * for no gain, and scrypt is memory-hard where PBKDF2 is not. The stored
 * format is self-describing, so the cost can be raised later and old hashes
 * still verify (and are re-hashed on the next successful sign-in).
 *
 * Sessions are server-side rows: the cookie carries only a random 256-bit id,
 * so signing someone out is a DELETE and a leaked cookie dies with the row.
 *
 * Online-guessing defence: after MAX_FAILURES wrong passwords an account is
 * locked for LOCK_MINUTES. Sign-in answers the same way for an unknown
 * e-mail, a wrong password and a disabled account, and always spends the
 * same work, so the response cannot be used to enumerate leaders.
 */
const crypto = require('crypto');
const { db } = require('../db');
const env = require('./env');

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };
const MAX_FAILURES = 8;
const LOCK_MINUTES = 15;
const MIN_PASSWORD = 12;
const COOKIE = 'tlstars_sid';

class AuthError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// ------------------------------------------------------------- passwords ---
const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, SCRYPT.keylen, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
});

/** "scrypt$N$r$p$<salt b64>$<hash b64>" — self-describing, so cost can change. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let key;
  try {
    key = await new Promise((resolve, reject) => {
      crypto.scrypt(password, Buffer.from(saltB64, 'base64'), expected.length,
        { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem },
        (err, k) => (err ? reject(err) : resolve(k)));
    });
  } catch { return false; }
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** True when `stored` was made with weaker parameters than we use now. */
function needsRehash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < SCRYPT.N || Number(parts[2]) < SCRYPT.r;
}

/**
 * Password rules. Length does the work — a 12-character passphrase beats a
 * mangled 8-character one, so there is no character-class theatre here. The
 * obvious guesses for this deployment are refused outright.
 */
const BANNED = [/^password/i, /^traillife/i, /^trailmen/i, /^letmein/i, /^changeme/i, /^12345/, /^qwerty/i];
function checkPasswordStrength(password, { email = '', name = '' } = {}) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (p.length > 200) return 'That password is too long (200 characters max).';
  if (/^\s|\s$/.test(p)) return 'Remove the leading or trailing space.';
  if (new Set(p).size < 5) return 'Use a few more different characters.';
  for (const re of BANNED) if (re.test(p)) return 'That password is too easy to guess — pick something unrelated to this app.';
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && p.toLowerCase().includes(local)) return 'Do not put your e-mail address in your password.';
  for (const word of String(name).toLowerCase().split(/\s+/)) {
    if (word.length >= 4 && p.toLowerCase().includes(word)) return 'Do not put your name in your password.';
  }
  return null;
}

// -------------------------------------------------------------- sessions ---
const nowIso = () => new Date().toISOString();

function createSession(userId, userAgent) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + env.SESSION_DAYS * 86400e3).toISOString();
  db.prepare(`INSERT INTO session (id, user_id, created_at, expires_at, last_seen_at, user_agent)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, userId, nowIso(), expires, nowIso(), String(userAgent || '').slice(0, 200));
  return { id, expires };
}

/** The signed-in user for a session id, or null. Touches last_seen_at. */
function userForSession(sid) {
  if (!sid) return null;
  const row = db.prepare(
    `SELECT s.id AS sid, s.expires_at, u.*
       FROM session s JOIN app_user u ON u.id = s.user_id
      WHERE s.id = ?`,
  ).get(sid);
  if (!row) return null;
  if (row.expires_at <= nowIso() || row.disabled_at) {
    db.prepare('DELETE FROM session WHERE id = ?').run(sid);
    return null;
  }
  db.prepare('UPDATE session SET last_seen_at = ? WHERE id = ?').run(nowIso(), sid);
  return {
    id: row.id, email: row.email, name: row.name, role: row.role, mustChange: !!row.must_change, sid: row.sid,
  };
}

const destroySession = (sid) => db.prepare('DELETE FROM session WHERE id = ?').run(sid).changes > 0;
const destroyUserSessions = (userId) => db.prepare('DELETE FROM session WHERE user_id = ?').run(userId).changes;
const pruneSessions = () => db.prepare('DELETE FROM session WHERE expires_at <= ?').run(nowIso()).changes;

// --------------------------------------------------------------- sign-in ---
/**
 * Verify an e-mail + password. Throws AuthError(401) for every kind of
 * failure with the same message, and always does scrypt work even for an
 * unknown e-mail, so timing does not reveal which leaders exist.
 */
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;
const SAME_ANSWER = 'That e-mail and password do not match.';

async function signIn(email, password, { userAgent = '' } = {}) {
  const e = String(email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM app_user WHERE email = ? COLLATE NOCASE').get(e);

  if (user && user.locked_until && user.locked_until > nowIso()) {
    throw new AuthError(429, `Too many attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString()}.`);
  }
  // Always spend the work, even when there is no such user.
  const ok = await verifyPassword(String(password || ''), user && !user.disabled_at ? user.password_hash : DUMMY_HASH);
  if (!user || user.disabled_at || !user.password_hash || !ok) {
    if (user && !user.disabled_at) {
      const failed = user.failed_count + 1;
      const lock = failed >= MAX_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60e3).toISOString() : null;
      db.prepare('UPDATE app_user SET failed_count = ?, locked_until = ? WHERE id = ?').run(failed, lock, user.id);
    }
    throw new AuthError(401, SAME_ANSWER);
  }

  if (needsRehash(user.password_hash)) {
    db.prepare('UPDATE app_user SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  }
  db.prepare('UPDATE app_user SET failed_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
    .run(nowIso(), user.id);
  const session = createSession(user.id, userAgent);
  return {
    session,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, mustChange: !!user.must_change },
  };
}

/** Change your own password: the current one must check out. */
async function changeOwnPassword(userId, currentPassword, newPassword) {
  const user = db.prepare('SELECT * FROM app_user WHERE id = ?').get(userId);
  if (!user) throw new AuthError(404, 'No such user.');
  if (!(await verifyPassword(String(currentPassword || ''), user.password_hash))) {
    throw new AuthError(401, 'Your current password does not match.');
  }
  const bad = checkPasswordStrength(newPassword, { email: user.email, name: user.name });
  if (bad) throw new AuthError(400, bad);
  if (await verifyPassword(newPassword, user.password_hash)) {
    throw new AuthError(400, 'That is the password you already have.');
  }
  db.prepare('UPDATE app_user SET password_hash = ?, must_change = 0 WHERE id = ?')
    .run(await hashPassword(newPassword), userId);
  return true;
}

// ------------------------------------------------------------ middleware ---
const cookieOpts = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env.SECURE_COOKIES,
  path: '/',
  maxAge: env.SESSION_DAYS * 86400e3,
});

/** Read the session cookie onto req.user (null when signed out). */
function attachUser(req, res, next) {
  req.user = userForSession(req.cookies ? req.cookies[COOKIE] : null);
  next();
}

/**
 * Gate a route. `role` 'admin' additionally requires the admin role.
 * A leader who must change their password may reach only the endpoints
 * flagged `allowMustChange` — otherwise the app would be usable without
 * ever retiring the password an admin typed for them.
 */
function requireUser(role = 'leader', { allowMustChange = false } = {}) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (req.user.mustChange && !allowMustChange) {
      return res.status(403).json({ error: 'password_change_required' });
    }
    if (role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    return next();
  };
}

module.exports = {
  COOKIE, MIN_PASSWORD, MAX_FAILURES, LOCK_MINUTES, AuthError,
  hashPassword, verifyPassword, needsRehash, checkPasswordStrength,
  createSession, userForSession, destroySession, destroyUserSessions, pruneSessions,
  signIn, changeOwnPassword, attachUser, requireUser, cookieOpts,
};

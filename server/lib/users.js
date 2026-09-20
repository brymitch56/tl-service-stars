'use strict';
/**
 * users.js — who may sign in. Admin-managed; there is no self-registration,
 * because the only people who belong here are leaders an admin already knows.
 *
 * Two safety rules the UI cannot talk its way past:
 *   - the last admin cannot be demoted, disabled or deleted (someone must be
 *     able to let people back in);
 *   - an admin never sees or sets another leader's password directly. They
 *     issue a one-time password, which the leader must replace at first
 *     sign-in (`must_change`). It is shown once, on screen, and never stored
 *     in readable form or e-mailed from here.
 *
 * ADMIN_EMAILS in .env is the recovery hatch: those addresses are treated as
 * admins whatever the database says, so a mistake in the UI can never lock
 * the troop out — fixing .env on the Pi always works.
 */
const crypto = require('crypto');
const { db } = require('../db');
const env = require('./env');
const auth = require('./auth');
const { audit } = require('./settings');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const lc = (s) => String(s || '').trim().toLowerCase();

class UserError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

/** .env admins outrank the stored role — the recovery hatch. */
const isEnvAdmin = (email) => env.ADMIN_EMAILS.includes(lc(email));

/** A user row as the API returns it — never the hash. */
function present(row) {
  if (!row) return null;
  const envAdmin = isEnvAdmin(row.email);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: envAdmin ? 'admin' : row.role,
    envAdmin,
    mustChange: !!row.must_change,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    disabled: !!row.disabled_at,
    locked: !!(row.locked_until && row.locked_until > new Date().toISOString()),
  };
}

const listUsers = () => db.prepare('SELECT * FROM app_user ORDER BY disabled_at IS NOT NULL, name COLLATE NOCASE')
  .all().map(present);

const getUser = (id) => present(db.prepare('SELECT * FROM app_user WHERE id = ?').get(id));

/** Effective role, honouring the .env hatch. */
function effectiveRole(row) {
  if (!row) return null;
  return isEnvAdmin(row.email) ? 'admin' : row.role;
}

function countActiveAdmins(excludeId = null) {
  const rows = db.prepare('SELECT * FROM app_user WHERE disabled_at IS NULL').all();
  return rows.filter((r) => effectiveRole(r) === 'admin' && r.id !== excludeId).length;
}

/**
 * A one-time password an admin can read out loud: four short words plus two
 * digits. Long enough to survive the rate limiter, short enough to dictate,
 * and replaced at first sign-in anyway.
 */
const WORDS = ['anchor', 'basin', 'cedar', 'dawn', 'ember', 'flint', 'gorge', 'harbor', 'ivory', 'jetty',
  'kettle', 'lantern', 'meadow', 'north', 'otter', 'pebble', 'quarry', 'ridge', 'summit', 'timber',
  'upland', 'valley', 'willow', 'yonder', 'zenith', 'boulder', 'canyon', 'delta', 'forge', 'granite'];
function temporaryPassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${pick()}-${crypto.randomInt(10, 100)}`;
}

/** Create a leader. Returns { user, tempPassword } — the password is shown once. */
async function createUser({ email, name, role = 'leader' }, actor) {
  const e = lc(email);
  if (!EMAIL_RE.test(e)) throw new UserError(400, `"${email}" is not an e-mail address.`);
  if (!String(name || '').trim()) throw new UserError(400, 'A name is required.');
  if (!['leader', 'admin'].includes(role)) throw new UserError(400, 'Role must be leader or admin.');
  if (db.prepare('SELECT 1 FROM app_user WHERE email = ? COLLATE NOCASE').get(e)) {
    throw new UserError(409, 'Someone with that e-mail already has an account.');
  }
  const tempPassword = temporaryPassword();
  const info = db.prepare(
    `INSERT INTO app_user (email, name, role, password_hash, must_change, created_at, created_by)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(e, String(name).trim(), role, await auth.hashPassword(tempPassword), new Date().toISOString(), actor);
  audit(actor, 'user.create', 'app_user', info.lastInsertRowid, null, { email: e, name, role });
  return { user: getUser(info.lastInsertRowid), tempPassword };
}

/**
 * Change a leader's name, e-mail or role.
 *
 * The e-mail is the sign-in identity, not a contact detail, so changing it
 * changes who this account *is*. Two consequences are deliberate:
 *   - every session of theirs ends, because the credential pair they are
 *     holding one half of no longer exists (the caller is told, so it can
 *     hand the browser doing the editing a fresh one if it is their own
 *     account);
 *   - an address listed in ADMIN_EMAILS cannot be edited here at all. Doing
 *     so would quietly revoke the recovery hatch — the account would keep
 *     whatever role the database says and lose the guarantee that .env can
 *     always let someone back in.
 *
 * Returns the updated user with { emailChanged } so the route can react.
 */
function updateUser(id, { name, email, role }, actor) {
  const row = db.prepare('SELECT * FROM app_user WHERE id = ?').get(id);
  if (!row) throw new UserError(404, 'No such user.');
  const before = present(row);

  let nextEmail = row.email;
  if (email !== undefined) {
    const e = lc(email);
    if (!EMAIL_RE.test(e)) throw new UserError(400, `"${email}" is not an e-mail address.`);
    if (e !== lc(row.email)) {
      if (isEnvAdmin(row.email)) {
        throw new UserError(409, 'This address is an admin in .env on the server; change it there first.');
      }
      if (db.prepare('SELECT 1 FROM app_user WHERE email = ? COLLATE NOCASE AND id <> ?').get(e, id)) {
        throw new UserError(409, 'Someone with that e-mail already has an account.');
      }
    }
    nextEmail = e;
  }
  const emailChanged = lc(nextEmail) !== lc(row.email);

  let nextName = row.name;
  if (name !== undefined) {
    nextName = String(name).trim();
    if (!nextName) throw new UserError(400, 'A name is required.');
  }

  const nextRole = role === undefined ? row.role : role;
  if (!['leader', 'admin'].includes(nextRole)) throw new UserError(400, 'Role must be leader or admin.');
  // Count admins as the row will be AFTER this change: an edit that moves the
  // account onto an ADMIN_EMAILS address keeps it an admin whatever the role
  // field says, and one that moves it off does not.
  const willBeAdmin = isEnvAdmin(nextEmail) || nextRole === 'admin';
  if (effectiveRole(row) === 'admin' && !willBeAdmin && countActiveAdmins(row.id) === 0) {
    throw new UserError(409, 'This is the only admin — make someone else an admin first.');
  }
  // Only an explicit demotion is refused. An .env admin whose stored role is
  // still "leader" is a normal state — .env outranks the column — and it must
  // not stop an admin from so much as fixing their name.
  if (isEnvAdmin(row.email) && role !== undefined && role !== 'admin') {
    throw new UserError(409, 'This address is an admin in .env on the server; remove it there first.');
  }

  db.prepare('UPDATE app_user SET name = ?, email = ?, role = ? WHERE id = ?')
    .run(nextName, nextEmail, nextRole, id);
  if (emailChanged) auth.destroyUserSessions(id);
  const after = getUser(id);
  audit(actor, 'user.update', 'app_user', id, before, after);
  return { ...after, emailChanged };
}

/** Issue a new one-time password. Every existing session of theirs is ended. */
async function resetPassword(id, actor) {
  const row = db.prepare('SELECT * FROM app_user WHERE id = ?').get(id);
  if (!row) throw new UserError(404, 'No such user.');
  const tempPassword = temporaryPassword();
  db.prepare('UPDATE app_user SET password_hash = ?, must_change = 1, failed_count = 0, locked_until = NULL WHERE id = ?')
    .run(await auth.hashPassword(tempPassword), id);
  auth.destroyUserSessions(id);
  audit(actor, 'user.reset_password', 'app_user', id, null, { email: row.email });
  return { user: getUser(id), tempPassword };
}

/** Disable (keeps the audit trail) or re-enable. Disabling ends their sessions. */
function setDisabled(id, disabled, actor) {
  const row = db.prepare('SELECT * FROM app_user WHERE id = ?').get(id);
  if (!row) throw new UserError(404, 'No such user.');
  if (disabled && effectiveRole(row) === 'admin' && countActiveAdmins(row.id) === 0) {
    throw new UserError(409, 'This is the only admin — make someone else an admin first.');
  }
  if (disabled && isEnvAdmin(row.email)) {
    throw new UserError(409, 'This address is an admin in .env on the server; remove it there first.');
  }
  db.prepare('UPDATE app_user SET disabled_at = ?, failed_count = 0, locked_until = NULL WHERE id = ?')
    .run(disabled ? new Date().toISOString() : null, id);
  if (disabled) auth.destroyUserSessions(id);
  audit(actor, disabled ? 'user.disable' : 'user.enable', 'app_user', id, null, { email: row.email });
  return getUser(id);
}

/** Clear a lockout without changing the password. */
function unlock(id, actor) {
  const row = db.prepare('SELECT * FROM app_user WHERE id = ?').get(id);
  if (!row) throw new UserError(404, 'No such user.');
  db.prepare('UPDATE app_user SET failed_count = 0, locked_until = NULL WHERE id = ?').run(id);
  audit(actor, 'user.unlock', 'app_user', id, null, { email: row.email });
  return getUser(id);
}

/**
 * First-run bootstrap: with no users at all, the first ADMIN_EMAILS address
 * gets an account and a one-time password, printed to the server log once.
 * Without this an installed app has nobody who can sign in.
 */
async function bootstrapIfEmpty(log = console.log) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM app_user').get();
  if (n > 0) return null;
  const email = env.ADMIN_EMAILS[0];
  if (!email) {
    log('[users] No accounts yet and ADMIN_EMAILS is empty — set ADMIN_EMAILS in .env, then restart.');
    return null;
  }
  const { tempPassword } = await createUser({ email, name: 'Administrator', role: 'admin' }, 'bootstrap');
  log('');
  log('  ┌─ First-run account ─────────────────────────────────────────');
  log(`  │  ${email}`);
  log(`  │  one-time password:  ${tempPassword}`);
  log('  │  You will be asked to set your own password at first sign-in.');
  log('  └─────────────────────────────────────────────────────────────');
  log('');
  return { email, tempPassword };
}

module.exports = {
  UserError, present, listUsers, getUser, effectiveRole, isEnvAdmin, countActiveAdmins,
  temporaryPassword, createUser, updateUser, resetPassword, setDisabled, unlock, bootstrapIfEmpty,
};

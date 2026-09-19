'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setupDb } = require('./helpers');

const { db } = setupDb();
const users = require('../server/lib/users');
const auth = require('../server/lib/auth');

test('a new leader gets a one-time password they must replace', async () => {
  const { user, tempPassword } = await users.createUser(
    { name: 'Sam Rivers', email: 'Sam@Example.com', role: 'leader' }, 'admin@example.com',
  );
  assert.equal(user.email, 'sam@example.com', 'e-mails are stored lower-case');
  assert.equal(user.mustChange, true);
  assert.ok(tempPassword.length >= 16, 'long enough to survive the rate limiter');
  const { user: signedIn } = await auth.signIn('sam@example.com', tempPassword);
  assert.equal(signedIn.mustChange, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'user.create'").get().n, 1,
    'creating an account is audited',
  );
});

test('duplicate e-mails and bad input are refused', async () => {
  await assert.rejects(() => users.createUser({ name: 'X', email: 'sam@example.com' }, 'a'), /already has an account/);
  await assert.rejects(() => users.createUser({ name: 'X', email: 'not-an-email' }, 'a'), /not an e-mail/);
  await assert.rejects(() => users.createUser({ name: '', email: 'ok@example.com' }, 'a'), /name is required/);
  await assert.rejects(() => users.createUser({ name: 'X', email: 'ok@example.com', role: 'root' }, 'a'), /leader or admin/);
});

test('a password reset ends every session that user had', async () => {
  const { tempPassword } = await users.createUser({ name: 'Theo Vance', email: 'theo@example.com' }, 'a');
  const { session } = await auth.signIn('theo@example.com', tempPassword);
  assert.ok(auth.userForSession(session.id));
  const u = db.prepare("SELECT id FROM app_user WHERE email = 'theo@example.com'").get();
  const reset = await users.resetPassword(u.id, 'admin@example.com');
  assert.equal(auth.userForSession(session.id), null, 'the old session is gone');
  assert.notEqual(reset.tempPassword, tempPassword);
  await auth.signIn('theo@example.com', reset.tempPassword);
});

test('disabling ends sessions; enabling brings the account back', async () => {
  const u = db.prepare("SELECT id FROM app_user WHERE email = 'theo@example.com'").get();
  const { tempPassword } = await users.resetPassword(u.id, 'a');
  const { session } = await auth.signIn('theo@example.com', tempPassword);
  users.setDisabled(u.id, true, 'admin@example.com');
  assert.equal(auth.userForSession(session.id), null);
  await assert.rejects(() => auth.signIn('theo@example.com', tempPassword), /do not match/);
  users.setDisabled(u.id, false, 'admin@example.com');
  await auth.signIn('theo@example.com', tempPassword);
});

test('the last admin cannot be demoted or disabled', async () => {
  const { user: admin } = await users.createUser({ name: 'Only Admin', email: 'only@example.com', role: 'admin' }, 'a');
  assert.equal(users.countActiveAdmins(), 1);
  assert.throws(() => users.updateUser(admin.id, { role: 'leader' }, 'a'), /only admin/);
  assert.throws(() => users.setDisabled(admin.id, true, 'a'), /only admin/);

  // With a second admin, the first may step down.
  const { user: second } = await users.createUser({ name: 'Second', email: 'second@example.com', role: 'admin' }, 'a');
  assert.equal(users.updateUser(admin.id, { role: 'leader' }, 'a').role, 'leader');
  assert.equal(users.countActiveAdmins(), 1);
  assert.throws(() => users.setDisabled(second.id, true, 'a'), /only admin/);
});

test('an .env admin outranks the database and cannot be locked out from the UI', async () => {
  process.env.ADMIN_EMAILS = 'recovery@example.com';
  const { user } = await users.createUser({ name: 'Recovery', email: 'recovery@example.com', role: 'leader' }, 'a');
  const view = users.listUsers().find((u) => u.email === 'recovery@example.com');
  assert.equal(view.role, 'admin', '.env promotes them whatever the row says');
  assert.equal(view.envAdmin, true);
  assert.throws(() => users.updateUser(user.id, { role: 'leader' }, 'a'), /\.env/);
  assert.throws(() => users.setDisabled(user.id, true, 'a'), /\.env/);
  process.env.ADMIN_EMAILS = '';
});

test('unlock clears a lockout without changing the password', async () => {
  const { tempPassword } = await users.createUser({ name: 'Locked', email: 'lockme@example.com' }, 'a');
  const u = db.prepare("SELECT id FROM app_user WHERE email = 'lockme@example.com'").get();
  for (let i = 0; i < auth.MAX_FAILURES; i++) await auth.signIn('lockme@example.com', 'wrong').catch(() => {});
  assert.equal(users.getUser(u.id).locked, true);
  users.unlock(u.id, 'admin@example.com');
  assert.equal(users.getUser(u.id).locked, false);
  await auth.signIn('lockme@example.com', tempPassword);
});

test('the first-run bootstrap only fires on an empty database', async () => {
  assert.equal(await users.bootstrapIfEmpty(() => {}), null, 'never on a database that already has accounts');
});

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

test('a leader can be renamed, and re-addressed', async () => {
  const { user, tempPassword } = await users.createUser({ name: 'Dana Wolfe', email: 'dana@example.com' }, 'a');
  const { session } = await auth.signIn('dana@example.com', tempPassword);

  // A rename touches nothing else: same address, same password, still signed in.
  const renamed = users.updateUser(user.id, { name: '  Dana Wolfe-Hart  ' }, 'admin@example.com');
  assert.equal(renamed.name, 'Dana Wolfe-Hart', 'the name is trimmed');
  assert.equal(renamed.email, 'dana@example.com');
  assert.equal(renamed.emailChanged, false);
  assert.ok(auth.userForSession(session.id), 'a rename does not sign anyone out');

  // The address is half the credential pair, so changing it ends their
  // sessions — but the password they know still works at the new address.
  const moved = users.updateUser(user.id, { email: 'Dana.Wolfe-Hart@Example.com' }, 'admin@example.com');
  assert.equal(moved.email, 'dana.wolfe-hart@example.com', 'stored lower-case');
  assert.equal(moved.emailChanged, true);
  assert.equal(auth.userForSession(session.id), null, 'the old session is gone');
  await assert.rejects(() => auth.signIn('dana@example.com', tempPassword), /do not match/);
  const back = await auth.signIn('dana.wolfe-hart@example.com', tempPassword);
  assert.equal(back.user.id, user.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'user.update'").get().n > 0, true,
    'edits are audited',
  );
});

test('an edit cannot collide with another account, or blank a name', async () => {
  const u = db.prepare("SELECT id FROM app_user WHERE email = 'dana.wolfe-hart@example.com'").get();
  assert.throws(() => users.updateUser(u.id, { email: 'second@example.com' }, 'a'), /already has an account/);
  assert.throws(() => users.updateUser(u.id, { email: 'nope' }, 'a'), /not an e-mail/);
  assert.throws(() => users.updateUser(u.id, { name: '   ' }, 'a'), /name is required/);
  // Re-stating the same address in different case is not a collision with itself.
  const same = users.updateUser(u.id, { email: 'DANA.WOLFE-HART@example.com' }, 'a');
  assert.equal(same.emailChanged, false, 'case alone is not a change');
});

test('an .env admin keeps the address .env names them by', async () => {
  process.env.ADMIN_EMAILS = 'recovery@example.com';
  const u = db.prepare("SELECT id FROM app_user WHERE email = 'recovery@example.com'").get();
  assert.throws(() => users.updateUser(u.id, { email: 'elsewhere@example.com' }, 'a'), /.env/);
  // Renaming them is fine — only the address is load-bearing.
  assert.equal(users.updateUser(u.id, { name: 'Recovery Account' }, 'a').name, 'Recovery Account');
  process.env.ADMIN_EMAILS = '';
});

test('moving the only admin onto an .env address leaves someone in charge', async () => {
  // The role field says leader, but ADMIN_EMAILS outranks it, so the troop is
  // not locked out and the edit is allowed.
  process.env.ADMIN_EMAILS = 'hatch@example.com';
  const { user } = await users.createUser({ name: 'Sole', email: 'sole@example.com', role: 'admin' }, 'a');
  for (const other of users.listUsers()) {
    if (other.id !== user.id && !other.disabled && other.role === 'admin') users.setDisabled(other.id, true, 'a');
  }
  assert.equal(users.countActiveAdmins(), 1, 'exactly one admin for this test');
  const moved = users.updateUser(user.id, { email: 'hatch@example.com', role: 'leader' }, 'a');
  assert.equal(moved.role, 'admin', '.env still promotes them');
  assert.equal(users.countActiveAdmins(), 1);
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

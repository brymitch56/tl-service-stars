'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setupDb } = require('./helpers');

const { db } = setupDb();
const auth = require('../server/lib/auth');

async function makeUser(email, password, role = 'leader') {
  const hash = await auth.hashPassword(password);
  return db.prepare(
    'INSERT INTO app_user (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
  ).get(email, 'Test Leader', role, hash, new Date().toISOString());
}

test('scrypt hashes verify, and differ for the same password', async () => {
  const a = await auth.hashPassword('fake-never-real-phrase-5v');
  const b = await auth.hashPassword('fake-never-real-phrase-5v');
  assert.notEqual(a, b, 'each hash carries its own salt');
  assert.ok(await auth.verifyPassword('fake-never-real-phrase-5v', a));
  assert.ok(!(await auth.verifyPassword('wrong', a)));
  assert.ok(!(await auth.verifyPassword('', a)));
  assert.match(a, /^scrypt\$32768\$8\$1\$/, 'the parameters travel with the hash');
  assert.equal(auth.needsRehash(a), false);
  assert.equal(auth.needsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA=='), true, 'weaker parameters are upgraded');
  assert.equal(auth.needsRehash('not-a-hash'), true);
});

test('a hash made with weaker parameters still verifies', async () => {
  // Hand-build a low-cost hash the way an older version would have.
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync('fake-old-never-real-1', salt, 64, { N: 1024, r: 8, p: 1 });
  const stored = `scrypt$1024$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
  assert.ok(await auth.verifyPassword('fake-old-never-real-1', stored));
  assert.ok(auth.needsRehash(stored));
});

test('password rules reject the guessable and the too-short', () => {
  const ctx = { email: 'sam.rivers@example.com', name: 'Sam Rivers' };
  assert.match(auth.checkPasswordStrength('short', ctx), /at least 12/);
  assert.match(auth.checkPasswordStrength('aaaaaaaaaaaaaaa', ctx), /different characters/);
  assert.match(auth.checkPasswordStrength('password12345', ctx), /too easy to guess/);
  assert.match(auth.checkPasswordStrength('traillife2026!', ctx), /too easy to guess/);
  assert.match(auth.checkPasswordStrength('sam.riverssam.rivers', ctx), /e-mail address/);
  assert.match(auth.checkPasswordStrength('rivers runs deep here', ctx), /your name/);
  assert.match(auth.checkPasswordStrength(' leading space here', ctx), /leading or trailing space/);
  assert.equal(auth.checkPasswordStrength('fake-never-real-phrase-7x', ctx), null);
});

test('sign-in works, and answers identically for every kind of failure', async () => {
  await makeUser('leader@example.com', 'fake-never-real-phrase-7x');
  const ok = await auth.signIn('LEADER@example.com', 'fake-never-real-phrase-7x');
  assert.equal(ok.user.email, 'leader@example.com');
  assert.ok(ok.session.id.length > 30);

  const wrongPassword = await auth.signIn('leader@example.com', 'nope').then(() => null, (e) => e);
  const unknownUser = await auth.signIn('ghost@example.com', 'nope').then(() => null, (e) => e);
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.equal(wrongPassword.message, unknownUser.message,
    'the answer must not reveal whether the account exists');
});

test('a session resolves to its user and dies when destroyed', async () => {
  const { session } = await auth.signIn('leader@example.com', 'fake-never-real-phrase-7x');
  const u = auth.userForSession(session.id);
  assert.equal(u.email, 'leader@example.com');
  assert.equal(u.role, 'leader');
  assert.ok(auth.destroySession(session.id));
  assert.equal(auth.userForSession(session.id), null);
  assert.equal(auth.userForSession('nonsense'), null);
  assert.equal(auth.userForSession(null), null);
});

test('an expired session is refused and cleaned up', async () => {
  const { session } = await auth.signIn('leader@example.com', 'fake-never-real-phrase-7x');
  db.prepare('UPDATE session SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', session.id);
  assert.equal(auth.userForSession(session.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM session WHERE id = ?').get(session.id).n, 0);
});

test('repeated wrong passwords lock the account, and the lock is honoured', async () => {
  const u = await makeUser('locked@example.com', 'fake-never-real-phrase-7x');
  for (let i = 0; i < auth.MAX_FAILURES; i++) {
    await auth.signIn('locked@example.com', 'wrong').catch(() => {});
  }
  const row = db.prepare('SELECT * FROM app_user WHERE id = ?').get(u.id);
  assert.equal(row.failed_count, auth.MAX_FAILURES);
  assert.ok(row.locked_until, 'the account is locked');
  const e = await auth.signIn('locked@example.com', 'fake-never-real-phrase-7x').then(() => null, (x) => x);
  assert.equal(e.status, 429, 'even the RIGHT password is refused while locked');
});

test('a successful sign-in clears the failure count', async () => {
  const u = await makeUser('resets@example.com', 'fake-never-real-phrase-7x');
  await auth.signIn('resets@example.com', 'wrong').catch(() => {});
  await auth.signIn('resets@example.com', 'fake-never-real-phrase-7x');
  const row = db.prepare('SELECT * FROM app_user WHERE id = ?').get(u.id);
  assert.equal(row.failed_count, 0);
  assert.ok(row.last_login_at);
});

test('a disabled account cannot sign in', async () => {
  const u = await makeUser('gone@example.com', 'fake-never-real-phrase-7x');
  db.prepare('UPDATE app_user SET disabled_at = ? WHERE id = ?').run(new Date().toISOString(), u.id);
  await assert.rejects(() => auth.signIn('gone@example.com', 'fake-never-real-phrase-7x'), /do not match/);
});

test('changing your own password needs the current one, and must be different', async () => {
  const u = await makeUser('changer@example.com', 'fake-never-real-phrase-7x');
  await assert.rejects(() => auth.changeOwnPassword(u.id, 'wrong', 'fake-never-real-phrase-8y'), /current password/);
  await assert.rejects(() => auth.changeOwnPassword(u.id, 'fake-never-real-phrase-7x', 'short'), /at least 12/);
  await assert.rejects(
    () => auth.changeOwnPassword(u.id, 'fake-never-real-phrase-7x', 'fake-never-real-phrase-7x'),
    /already have/,
  );
  assert.ok(await auth.changeOwnPassword(u.id, 'fake-never-real-phrase-7x', 'fake-never-real-phrase-8y'));
  await auth.signIn('changer@example.com', 'fake-never-real-phrase-8y');
  assert.equal(db.prepare('SELECT must_change FROM app_user WHERE id = ?').get(u.id).must_change, 0);
});

test('pruning removes only expired sessions', async () => {
  const { session } = await auth.signIn('leader@example.com', 'fake-never-real-phrase-7x');
  db.prepare("INSERT INTO session (id, user_id, created_at, expires_at) VALUES ('old', ?, ?, ?)")
    .run(1, '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z');
  auth.pruneSessions();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM session WHERE id = 'old'").get().n, 0);
  assert.ok(auth.userForSession(session.id), 'a live session survives');
});

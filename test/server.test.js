'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setupDb, fakeClient } = require('./helpers');

const { db } = setupDb();
const { createApp, XRW } = require('../server/app');
const users = require('../server/lib/users');
const sync = require('../server/lib/sync');
const F = require('./fixtures');

let base;
let server;
const jar = { admin: '', leader: '' };

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

/** fetch with the app's own anti-CSRF header and a cookie jar. */
async function call(path, { method = 'GET', body, who = 'admin', xhr = true } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(xhr ? { 'X-Requested-With': XRW } : {}),
      ...(jar[who] ? { Cookie: jar[who] } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookie) {
    const pair = c.split(';')[0];
    if (pair.startsWith('tlstars_sid=')) jar[who] = pair;
  }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data };
}

async function signIn(who, email, password) {
  jar[who] = '';
  return call('/api/signin', { method: 'POST', body: { email, password }, who });
}

test('health is public; everything else needs a session', async () => {
  const h = await call('/health', { who: 'nobody' });
  assert.equal(h.status, 200);
  assert.equal(h.data.app, 'tl-service-stars');
  for (const p of ['/api/me', '/api/progress', '/api/proposals', '/api/users', '/api/portal']) {
    assert.equal((await call(p, { who: 'nobody' })).status, 401, `${p} must require a session`);
  }
});

test('the icons render, and the favicon is a real PNG', async () => {
  const svg = await fetch(`${base}/icon.svg`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /svg/);
  const body = await svg.text();
  assert.match(body, /<path d="M256 152/, 'the star path is drawn');

  const png = await fetch(`${base}/favicon.ico`);
  const buf = Buffer.from(await png.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4E, 0x47], 'PNG magic bytes');
});

test('a mutating call without the anti-CSRF header is refused', async () => {
  const r = await call('/api/signin', {
    method: 'POST', body: { email: 'x@example.com', password: 'y' }, who: 'nobody', xhr: false,
  });
  assert.equal(r.status, 403);
});

test('first sign-in forces a password change before anything else works', async () => {
  const { tempPassword } = await users.createUser(
    { name: 'Ada Admin', email: 'ada@example.com', role: 'admin' }, 'test',
  );
  const first = await signIn('admin', 'ada@example.com', tempPassword);
  assert.equal(first.status, 200);
  assert.equal(first.data.user.mustChange, true);

  const blocked = await call('/api/progress', { who: 'admin' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error, 'password_change_required');

  const weak = await call('/api/password', {
    method: 'POST', who: 'admin', body: { currentPassword: tempPassword, newPassword: 'short' },
  });
  assert.equal(weak.status, 400);

  const ok = await call('/api/password', {
    method: 'POST', who: 'admin', body: { currentPassword: tempPassword, newPassword: 'fake-never-real-phrase-9z' },
  });
  assert.equal(ok.status, 200);
  assert.equal((await call('/api/progress', { who: 'admin' })).status, 200);
});

test('/api/me never returns the session id', async () => {
  const me = await call('/api/me', { who: 'admin' });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.sid, undefined, 'the httpOnly cookie must not be echoed to the page');
  assert.equal(me.data.user.role, 'admin');
});

test('a leader is kept out of the admin routes', async () => {
  const { tempPassword } = await users.createUser({ name: 'Lee Leader', email: 'lee@example.com' }, 'ada@example.com');
  await signIn('leader', 'lee@example.com', tempPassword);
  await call('/api/password', {
    method: 'POST', who: 'leader', body: { currentPassword: tempPassword, newPassword: 'fake-never-real-phrase-6w' },
  });
  assert.equal((await call('/api/progress', { who: 'leader' })).status, 200, 'leaders may read progress');
  for (const p of ['/api/users', '/api/portal', '/api/push', '/api/audit']) {
    assert.equal((await call(p, { who: 'leader' })).status, 403, `${p} is admin-only`);
  }
  assert.equal((await call('/api/push/enabled', {
    method: 'POST', who: 'leader', body: { enabled: true },
  })).status, 403);
});

test('the whole flow: sync, see progress, approve a star, watch it queue', async () => {
  const id = 'uaaaaaaaaaaa';
  const routes = {
    'GET /login': F.DASHBOARD,
    'GET /advancement/index': F.advancementIndex([{ id, name: 'Rivers, Sam' }]),
    [`GET /profile/${id}`]: F.profilePage(id, {
      ledger: F.ledgerGrid([
        F.ledgerRow({ key: 's1', date: '09/10/2024', act: 'Food bank', hours: '20', level: 'Navigator' }),
        F.ledgerRow({ key: 's2', date: '03/04/2025', act: 'Park clean-up', hours: '14', level: 'Navigator' }),
        F.ledgerRow({ key: 's3', date: '01/01/2024', act: 'Old project', hours: '9', level: 'Mountain Lion' }),
      ], { totalHours: '43' }),
      awards: [],
    }),
  };
  const r = await sync.runSync({ trigger: 'test', client: fakeClient(routes) });
  assert.equal(r.ok, true, r.error || '');

  const prog = await call('/api/progress', { who: 'admin' });
  assert.equal(prog.status, 200);
  const sam = prog.data.trailmen[0];
  assert.equal(sam.name, 'Rivers, Sam');
  const nav = sam.levels.find((l) => l.level === 'Navigator');
  assert.equal(nav.hours, '34.00');
  assert.equal(nav.expected, 2, '34 Navigator hours are two stars');
  assert.equal(sam.woodlands, '9.00', 'Mountain Lion hours are shown but not counted');

  const detail = await call(`/api/trailmen/${sam.id}`, { who: 'admin' });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.serviceRows.length, 3);
  assert.equal(detail.data.serviceRows.filter((x) => x.counts).length, 2);

  const list = await call('/api/proposals', { who: 'admin' });
  assert.equal(list.data.proposals.length, 2);

  const first = list.data.proposals[0];
  const approved = await call(`/api/proposals/${first.id}/approve`, { method: 'POST', who: 'admin' });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.pushEnabled, false, 'approving does not write while the switch is off');
  assert.equal(approved.data.queued.state, 'queued');

  const second = list.data.proposals[1];
  assert.equal((await call(`/api/proposals/${second.id}/reject`, { method: 'POST', who: 'admin' })).status, 200);
  assert.equal((await call('/api/proposals', { who: 'admin' })).data.proposals.length, 0);

  // A rejection can be undone, because a rejected ordinal is never re-proposed.
  assert.equal((await call(`/api/proposals/${second.id}/reopen`, { method: 'POST', who: 'admin' })).status, 200);
  assert.equal((await call('/api/proposals', { who: 'admin' })).data.proposals.length, 1);
});

test('a leader can record how extra stars should be treated', async () => {
  const tm = db.prepare('SELECT * FROM trailman LIMIT 1').get();
  const bad = await call(`/api/trailmen/${tm.id}/legacy-mode`, {
    method: 'POST', who: 'leader', body: { level: 'Navigator', mode: 'nonsense' },
  });
  assert.equal(bad.status, 400);
  const ok = await call(`/api/trailmen/${tm.id}/legacy-mode`, {
    method: 'POST', who: 'leader', body: { level: 'Navigator', mode: 'woodlands' },
  });
  assert.equal(ok.status, 200);
  assert.equal(
    db.prepare('SELECT legacy_mode FROM star_baseline WHERE trailman_id = ? AND level = ?').get(tm.id, 'Navigator').legacy_mode,
    'woodlands',
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'baseline.legacy_mode'").get().n, 1,
    'a ruling about history is audited',
  );
});

test('the push switch is admin-only and off by default', async () => {
  const before = await call('/api/push', { who: 'admin' });
  assert.equal(before.data.enabled, false);
  assert.equal((await call('/api/push/run', { method: 'POST', who: 'admin' })).status, 409,
    'a run with the switch off is refused');
  assert.equal((await call('/api/push/enabled', {
    method: 'POST', who: 'admin', body: { enabled: true },
  })).data.enabled, true);
  await call('/api/push/enabled', { method: 'POST', who: 'admin', body: { enabled: false } });
});

test('signing out invalidates the session immediately', async () => {
  assert.equal((await call('/api/signout', { method: 'POST', who: 'leader' })).status, 200);
  assert.equal((await call('/api/me', { who: 'leader' })).status, 401);
});

test('unknown paths serve the app shell, but /api/ does not', async () => {
  const page = await fetch(`${base}/anything/at/all`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Service Stars<\/title>/);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});

test('the worker script and the shell are never served from a stale cache', async () => {
  // A browser only discovers a new version by re-fetching sw.js. Caching it
  // is how an installed app gets stranded on an old build.
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('cache-control') || '', /no-cache|no-store/);
  assert.match(sw.headers.get('content-type') || '', /javascript/);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  const body = await sw.text();
  assert.match(body, /const VERSION = 'tls-v\d+'/, 'the worker carries a bumpable version');
  assert.match(body, /skipWaiting/, 'a new worker must not wait for every window to close');
  assert.ok(!/\/api/.test(body.split('fetch handler')[0]) || /startsWith\('\/api'\)/.test(body),
    'the worker must exempt /api');

  const shell = await fetch(`${base}/anything`);
  assert.match(shell.headers.get('cache-control') || '', /no-cache|no-store/);
});

test('the worker never caches authenticated API traffic', async () => {
  const body = await (await fetch(`${base}/sw.js`)).text();
  // The exemption must come before any caching decision.
  const apiGuard = body.indexOf("url.pathname.startsWith('/api')");
  const firstRespond = body.indexOf('e.respondWith');
  assert.ok(apiGuard > 0, '/api is exempted');
  assert.ok(apiGuard < firstRespond, '/api is exempted before anything is served from cache');
});

// ------------------------------------------------- self-serve password ----
test('a leader can change their own password, and it ends other sessions', async () => {
  const { tempPassword } = await users.createUser(
    { name: 'Pat Warden', email: 'pat@example.com' }, 'ada@example.com',
  );
  // Sign in twice — two devices.
  const one = { ...jar }; // placeholder so the helper's shape is obvious
  jar.devA = ''; jar.devB = '';
  await call('/api/signin', { method: 'POST', body: { email: 'pat@example.com', password: tempPassword }, who: 'devA' });
  await call('/api/password', {
    method: 'POST', who: 'devA', body: { currentPassword: tempPassword, newPassword: 'fake-never-real-phrase-1a' },
  });
  await call('/api/signin', { method: 'POST', body: { email: 'pat@example.com', password: 'fake-never-real-phrase-1a' }, who: 'devB' });
  assert.equal((await call('/api/me', { who: 'devA' })).status, 200, 'device A is still signed in');
  assert.equal((await call('/api/me', { who: 'devB' })).status, 200, 'device B is signed in too');

  // Change it from device B: A must be booted, B must survive.
  const r = await call('/api/password', {
    method: 'POST', who: 'devB',
    body: { currentPassword: 'fake-never-real-phrase-1a', newPassword: 'fake-never-real-phrase-2b' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.otherSessionsEnded, 1, 'the other device was signed out');
  assert.equal((await call('/api/me', { who: 'devA' })).status, 401, 'device A is signed out');
  assert.equal((await call('/api/me', { who: 'devB' })).status, 200,
    'the device that made the change keeps working, on a fresh session');

  // The old password is dead, the new one works.
  jar.devC = '';
  assert.equal((await call('/api/signin', {
    method: 'POST', who: 'devC', body: { email: 'pat@example.com', password: 'fake-never-real-phrase-1a' },
  })).status, 401);
  assert.equal((await call('/api/signin', {
    method: 'POST', who: 'devC', body: { email: 'pat@example.com', password: 'fake-never-real-phrase-2b' },
  })).status, 200);
  assert.ok(one);
});

test('changing a password still needs the current one', async () => {
  const bad = await call('/api/password', {
    method: 'POST', who: 'admin',
    body: { currentPassword: 'not-my-password', newPassword: 'fake-never-real-phrase-3c' },
  });
  assert.equal(bad.status, 401);
  assert.match(bad.data.error, /current password/);
  // and the admin's own session is untouched by the failed attempt
  assert.equal((await call('/api/me', { who: 'admin' })).status, 200);
});

test('the change-password route is reachable, and audited', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'user.password_changed'").get().n;
  await call('/api/password', {
    method: 'POST', who: 'admin',
    body: { currentPassword: 'fake-never-real-phrase-9z', newPassword: 'fake-never-real-phrase-4d' },
  });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'user.password_changed'").get().n,
    before + 1, 'a password change leaves a trail');
});

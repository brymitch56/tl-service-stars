'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tlcLib = require('../lib/tlc');
const F = require('./fixtures');

const { makeConfig, makeClient, guard, EXIT } = tlcLib;

const cfg = (over = {}) => makeConfig({
  TLC_BASE: 'https://portal.example.org',
  TLC_EMAIL: 'leader@example.com',
  TLC_PASSWORD: 'fake-password-never-real',
  TLC_THROTTLE_MS: '0',
  ...over,
});

/** A fetch stand-in driven by a path → handler map. Records every call. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${(opts.method || 'GET').toUpperCase()} ${u.pathname}`;
    calls.push({ key, url, search: u.search, body: opts.body, headers: opts.headers });
    const h = routes[key];
    if (!h) throw new Error(`unexpected request: ${key}`);
    const r = typeof h === 'function' ? h({ url: u, opts, calls }) : h;
    const body = typeof r === 'string' ? r : r.body || '';
    const status = typeof r === 'string' ? 200 : (r.status || 200);
    const headers = new Headers(typeof r === 'string' ? {} : (r.headers || {}));
    return { status, headers, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

// ------------------------------------------------------------- allow-list --
test('the read allow-list refuses everything that writes', () => {
  const allowed = [['/profile/uaaaaaaaaaaa', 'GET'], ['/advancement/index', 'GET'],
    ['/advancement/badge-tracker-view', 'POST'], ['/activities', 'GET'], ['/login', 'POST']];
  for (const [p, m] of allowed) assert.doesNotThrow(() => guard(p, m), `${m} ${p} should be allowed`);

  const refused = [
    ['/advancement/index', 'POST'],              // the SAVE — never from request()
    ['/fields/toggleServiceActive/abc', 'GET'],  // a GET that writes
    ['/advancement/delete', 'GET'],
    ['/advancement/process-advancement', 'POST'],
    ['/fields/service-update', 'POST'],
    ['/user/index', 'GET'],
  ];
  for (const [p, m] of refused) assert.throws(() => guard(p, m), `${m} ${p} must be refused`);
});

test('the client itself will not fetch a write endpoint', async () => {
  const c = makeClient(cfg(), { fetchImpl: fakeFetch({}) });
  await assert.rejects(() => c.getText('/fields/toggleServiceActive/abc?attribute=verified'),
    /changes data on Trail Life Connect/);
});

// ------------------------------------------------------------------ login --
test('a password sign-in stores the cookie jar', async () => {
  const saved = [];
  const store = {
    loadCookies: () => null,
    saveCookies: (jar, base) => saved.push({ lines: jar.lines(), base }),
    touch: () => {}, putChallenge: () => null, clearChallenge: () => {},
  };
  const fetchImpl = fakeFetch({
    'GET /login': { body: F.LOGIN_PAGE, headers: { 'set-cookie': '_csrf=abc; Path=/' } },
    'POST /login': { status: 302, body: '', headers: { location: '/dashboard', 'set-cookie': 'PHPSESSID=live; Path=/' } },
    'GET /dashboard': F.DASHBOARD,
  });
  const c = makeClient(cfg(), { fetchImpl, store });
  const token = await c.login();
  assert.equal(token, 'signed-in-csrf');
  assert.equal(saved.length, 1);
  assert.ok(saved[0].lines.some((l) => l.startsWith('PHPSESSID=')), 'the session cookie is kept');
});

test('a stored session is reused and no password is posted', async () => {
  const store = {
    loadCookies: () => ['PHPSESSID=stored'], saveCookies: () => {}, touch: () => {},
    putChallenge: () => null, clearChallenge: () => {},
  };
  const fetchImpl = fakeFetch({ 'GET /login': F.DASHBOARD });
  const c = makeClient(cfg(), { fetchImpl, store });
  await c.login();
  assert.equal(fetchImpl.calls.filter((x) => x.key === 'POST /login').length, 0,
    'a live session must not trigger a password sign-in');
});

test('a code prompt parks a challenge and stops — it is never retried', async () => {
  const parked = [];
  const store = {
    loadCookies: () => null, saveCookies: () => {}, touch: () => {},
    putChallenge: (c) => { parked.push(c); return { id: 'x1' }; }, clearChallenge: () => {},
  };
  const fetchImpl = fakeFetch({
    'GET /login': { body: F.LOGIN_PAGE, headers: { 'set-cookie': '_csrf=abc; Path=/' } },
    'POST /login': { body: F.CODE_PAGE, headers: { 'set-cookie': 'PHPSESSID=half; Path=/' } },
  });
  const c = makeClient(cfg(), { fetchImpl, store });
  const err = await c.login().then(() => null, (e) => e);
  assert.ok(err, 'login must not resolve when a code is wanted');
  assert.equal(err.code, EXIT.CODE_REQUIRED);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].challenge.field, 'VerifyForm[code]');
  assert.equal(parked[0].challenge.action, '/login/verify');
  assert.match(parked[0].prompt, /code/i);
  assert.equal(fetchImpl.calls.filter((x) => x.key === 'POST /login').length, 1, 'exactly one attempt');
});

test('a bad password fails immediately, with no retry loop', async () => {
  const fetchImpl = fakeFetch({
    'GET /login': F.LOGIN_PAGE,
    'POST /login': F.LOGIN_PAGE, // the form comes back = rejected
  });
  const c = makeClient(cfg(), { fetchImpl });
  await assert.rejects(() => c.login({ useStored: false }), /do NOT retry in a loop/);
  assert.equal(fetchImpl.calls.filter((x) => x.key === 'POST /login').length, 1);
});

test('the code is posted with the form the portal gave us', async () => {
  const fetchImpl = fakeFetch({
    'POST /login/verify': { status: 302, body: '', headers: { location: '/dashboard' } },
    'GET /dashboard': F.DASHBOARD,
  });
  const c = makeClient(cfg(), { fetchImpl });
  await c.submitChallenge({
    action: '/login/verify', field: 'VerifyForm[code]', hidden: { _csrf: 'code-csrf' },
    csrf: 'code-csrf', cookies: ['PHPSESSID=half'],
  }, '123456');
  const call = fetchImpl.calls.find((x) => x.key === 'POST /login/verify');
  assert.match(call.body, /VerifyForm%5Bcode%5D=123456/);
  assert.match(call.body, /_csrf=code-csrf/);
  assert.match(call.headers.Cookie, /PHPSESSID=half/);
});

// ----------------------------------------------------------------- paging --
test('the ledger is paged until the footer count is satisfied', async () => {
  const row = (i) => F.ledgerRow({ key: `r${i}`, date: '01/02/2024', act: 'Service', hours: '2', level: 'Navigator' });
  const page1 = [];
  for (let i = 0; i < 100; i++) page1.push(row(i));
  const page2 = [];
  for (let i = 100; i < 172; i++) page2.push(row(i));

  const fetchImpl = fakeFetch({
    'GET /login': F.DASHBOARD,
    'GET /profile/uaaaaaaaaaaa': ({ url }) => {
      const page = url.searchParams.get('page');
      const rows = page === '2' ? page2 : page1;
      return F.profilePage(F.TRAILMAN_A, { ledger: F.ledgerGrid(rows, { declared: 172, totalHours: '344' }), awards: [] });
    },
  });
  const store = { loadCookies: () => ['PHPSESSID=x'], saveCookies: () => {}, touch: () => {}, putChallenge: () => null, clearChallenge: () => {} };
  const c = makeClient(cfg(), { fetchImpl, store });
  await c.login();
  const data = await c.fetchTrailmanService(F.TRAILMAN_A);
  assert.equal(data.ledger.rows.length, 172);
  assert.equal(data.ledger.complete, true);
  assert.equal(data.pagesRead, 2);
});

test('paging gives up rather than looping when the portal ignores ?page=', async () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push(F.ledgerRow({ key: `r${i}`, date: '01/02/2024', act: 'S', hours: '1', level: 'Navigator' }));
  }
  const fetchImpl = fakeFetch({
    'GET /login': F.DASHBOARD,
    // Always the same page, whatever ?page= says.
    'GET /profile/uaaaaaaaaaaa': F.profilePage(F.TRAILMAN_A, {
      ledger: F.ledgerGrid(rows, { declared: 500, totalHours: '100' }), awards: [],
    }),
  });
  const store = { loadCookies: () => ['PHPSESSID=x'], saveCookies: () => {}, touch: () => {}, putChallenge: () => null, clearChallenge: () => {} };
  const c = makeClient(cfg(), { fetchImpl, store });
  await c.login();
  const data = await c.fetchTrailmanService(F.TRAILMAN_A);
  assert.equal(data.ledger.complete, false, 'an unsatisfiable ledger stays incomplete');
  assert.ok(data.pagesRead <= 3, `should stop quickly, read ${data.pagesRead} pages`);
  assert.ok(data.warnings.some((w) => /added no rows|records read/.test(w)));
});

test('fetchTrailmanService refuses anything that is not a trailman hashid', async () => {
  const c = makeClient(cfg(), { fetchImpl: fakeFetch({}) });
  await assert.rejects(() => c.fetchTrailmanService('../../etc/passwd'), /trailman hashid/);
  await assert.rejects(() => c.fetchTrailmanService('j8e296a067a3'), /trailman hashid/);
});

test('a code prompt behind a redirect to an unlisted path still parks', async () => {
  // What the live portal actually does: the password is accepted, a text is
  // sent, and it 302s to a verification page. That path is not — and cannot
  // be — on the READ allow-list, so holding sign-in hops to that list turned
  // "enter the code we just texted you" into an opaque failure.
  const parked = [];
  const store = {
    loadCookies: () => null, saveCookies: () => {}, touch: () => {},
    putChallenge: (c) => { parked.push(c); return { id: 'x1' }; }, clearChallenge: () => {},
  };
  const fetchImpl = fakeFetch({
    'GET /login': { body: F.LOGIN_PAGE, headers: { 'set-cookie': '_csrf=abc; Path=/' } },
    'POST /login': {
      status: 302, body: '',
      headers: { location: '/user/two-factor-verify', 'set-cookie': 'PHPSESSID=half; Path=/' },
    },
    'GET /user/two-factor-verify': F.CODE_PAGE,
  });
  const c = makeClient(cfg(), { fetchImpl, store });
  const err = await c.login().then(() => null, (e) => e);
  assert.ok(err, 'login must not resolve');
  assert.equal(err.code, EXIT.CODE_REQUIRED, `expected a parked code prompt, got: ${err.message}`);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].challenge.field, 'VerifyForm[code]');
});

test('sign-in still refuses a hop to a data-changing endpoint', async () => {
  const fetchImpl = fakeFetch({
    'GET /login': { body: F.LOGIN_PAGE, headers: { 'set-cookie': '_csrf=abc; Path=/' } },
    'POST /login': { status: 302, body: '', headers: { location: '/advancement/delete?id=x' } },
  });
  const c = makeClient(cfg(), { fetchImpl });
  await assert.rejects(() => c.login({ useStored: false, park: false }), /changes data/);
});

test('sign-in cookies never follow a redirect off the portal', async () => {
  const fetchImpl = fakeFetch({
    'GET /login': { body: F.LOGIN_PAGE, headers: { 'set-cookie': '_csrf=abc; Path=/' } },
    'POST /login': { status: 302, body: '', headers: { location: 'https://evil.example.com/collect' } },
  });
  const c = makeClient(cfg(), { fetchImpl });
  await assert.rejects(() => c.login({ useStored: false, park: false }), /refusing to send portal cookies/);
});

test('an unrecognised page after the password is reported, with field names only', async () => {
  const seen = [];
  const fetchImpl = fakeFetch({
    'GET /login': { body: F.LOGIN_PAGE, headers: { 'set-cookie': '_csrf=abc; Path=/' } },
    // No password field, no code-shaped field: something we do not know.
    'POST /login': '<html><body><form action="/odd"><input name="SomethingNew[answer]" type="text">'
      + '<input name="secret" type="hidden" value="do-not-log-me"></form></body></html>',
  });
  const c = makeClient(cfg(), { fetchImpl, log: (m) => seen.push(m) });
  await assert.rejects(() => c.login({ useStored: false, park: false }), /does not recognise/);
  const line = seen.join('\n');
  assert.match(line, /SomethingNew\[answer\]:text/, 'the log names the fields it saw');
  assert.ok(!/do-not-log-me/.test(line), 'a value must never reach the log');
});

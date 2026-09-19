'use strict';
/**
 * Every database-backed test runs against its own throwaway file, set up
 * BEFORE server/db.js is first required (it opens the path at load time).
 * Call setupDb() at the top of the test file, before any server/ require.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlstars-test-'));
  process.env.DATA_DIR = dir;
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.ENV_FILE = path.join(dir, '.env');
  // A fixed key so the vault works without writing a real .env anywhere.
  process.env.CRED_KEY = crypto.randomBytes(32).toString('hex');
  process.env.SECURE_COOKIES = 'false';
  process.env.DISABLE_SCHEDULER = 'true';
  process.env.ADMIN_EMAILS = '';
  fs.writeFileSync(process.env.ENV_FILE, '');

  const { db } = require('../server/db');
  const migDir = path.join(__dirname, '..', 'server', 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  }
  return { db, dir };
}

/** A fetch stand-in driven by a "METHOD /path" → handler map. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${(opts.method || 'GET').toUpperCase()} ${u.pathname}`;
    calls.push({ key, url: u, search: u.search, body: opts.body, headers: opts.headers });
    const h = routes[key];
    if (!h) throw new Error(`unexpected request: ${key}`);
    const r = typeof h === 'function' ? h({ url: u, opts, calls }) : h;
    const body = typeof r === 'string' ? r : r.body || '';
    const status = typeof r === 'string' ? 200 : (r.status || 200);
    return { status, headers: new Headers(typeof r === 'string' ? {} : (r.headers || {})), text: async () => body };
  };
  impl.calls = calls;
  impl.routes = routes;
  return impl;
}

/** A TLC client wired to fake routes and a live (in-memory) session store. */
function fakeClient(routes, { store } = {}) {
  const tlcLib = require('../lib/tlc');
  const cfg = tlcLib.makeConfig({
    TLC_BASE: 'https://portal.example.org',
    TLC_EMAIL: 'leader@example.com',
    TLC_PASSWORD: 'fake-password-never-real',
    TLC_THROTTLE_MS: '0',
  });
  const fetchImpl = fakeFetch(routes);
  const client = tlcLib.makeClient(cfg, {
    fetchImpl,
    store: store || {
      loadCookies: () => ['PHPSESSID=test'], saveCookies: () => {}, touch: () => {},
      putChallenge: () => null, clearChallenge: () => {},
    },
  });
  client.fetchImpl = fetchImpl;
  return client;
}

module.exports = { setupDb, fakeFetch, fakeClient };

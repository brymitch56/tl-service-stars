'use strict';
/**
 * tlc.js — authenticated HTTP client for Trail Life Connect.
 *
 * READ-ONLY by construction. `request()` refuses any path that is not on the
 * allow-list BEFORE a request leaves the process, and refuses outright the
 * endpoints that change data. The single write this project makes
 * (`POST /advancement/index`, the Standard-view save) goes through
 * `postAdvancementIndex`, which bypasses the read allow-list deliberately and
 * is called from exactly one module: server/lib/starspush.js. See CLAUDE.md.
 *
 * SIGN-IN (proven against this platform in troop-checkin's roster fetch):
 *   1. GET  /login   -> _csrf token + cookies
 *   2. POST /login   -> LoginForm[email] / LoginForm[password]; 302 on success
 *      ...or a CODE FORM, because the portal now demands a second factor at
 *      every password sign-in. The half-authenticated jar and that form are
 *      parked for a human to finish in the app; once finished, the resulting
 *      cookie jar is stored and every later job reuses it without a code.
 *   3. cookies are kept in a hand-rolled jar and redirects are followed
 *      manually, so a cookie set mid-chain is absorbed.
 *
 * Automatic code retrieval is deliberately NOT built. An unattended relay
 * that reads the code collapses two factors into one on an account that
 * reaches youth records. A human typing six digits once per session lifetime
 * is the entire security value of the second factor.
 *
 * Credentials never appear in logs, errors, or written files.
 */
const {
  csrfFrom, formsIn, inputsIn, attrOf,
} = require('./html');
const {
  parseProfileService, parseTrailmenIndex, mergeLedgerPages, PAGE_CAP,
} = require('./service');

// ---------------------------------------------------------------- errors ---
/** code: 1 config · 2 auth · 3 fetch · 4 parse · 6 code required · 7 code rejected */
class TlcError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}
const fail = (code, msg) => { throw new TlcError(code, msg); };
const EXIT = { CONFIG: 1, AUTH: 2, FETCH: 3, PARSE: 4, CODE_REQUIRED: 6, CODE_REJECTED: 7 };

// --------------------------------------------------------- endpoint guard ---
// Path (no query) -> allowed methods. Anything else throws BEFORE a request
// is made. This is the read-only rule from CLAUDE.md, in code.
const ALLOWED_PATHS = {
  '/': ['GET'],
  '/login': ['GET', 'POST'],
  '/logout': ['GET'],
  '/dashboard': ['GET'],
  '/dashboard/index': ['GET'],
  '/advancement/index': ['GET'],              // POST here is the SAVE — never from request()
  '/advancement/badge-tracker-view': ['POST'], // read-only HTML fragment
  '/activities': ['GET'],
  '/profile': ['GET'],
};
// Path patterns for ids-in-path pages (GET only).
const ALLOWED_PATTERNS = [
  { re: /^\/profile\/u[a-z0-9]{11}$/, methods: ['GET'] },
];
// Endpoints that WRITE and are never called, whatever the method.
// (`toggleServiceActive` is a GET that flips a service-hours approval.)
const FORBIDDEN_PATH_RE = /^\/(fields\/toggleServiceActive(\/|$)|advancement\/(delete|process-advancement|update)(\/|$)|fields\/[a-z-]*update(\/|$))/i;

function guard(pathname, method) {
  if (FORBIDDEN_PATH_RE.test(pathname)) {
    fail(EXIT.CONFIG, `refusing ${method} ${pathname} — that endpoint changes data on Trail Life Connect`);
  }
  const m = String(method || 'GET').toUpperCase();
  const exact = ALLOWED_PATHS[pathname];
  if (exact && exact.includes(m)) return;
  for (const p of ALLOWED_PATTERNS) if (p.re.test(pathname) && p.methods.includes(m)) return;
  fail(EXIT.CONFIG, `refusing ${m} ${pathname} — not on the read-only allow-list`);
}

/**
 * The second-factor form posts wherever the portal's own HTML says to, and
 * that path is not knowable in advance (it was `/login` on one sibling portal
 * and a separate verify route on another). So the challenge POST gets its own,
 * narrower guard instead of the read allow-list:
 *
 *   - the path still may not be one of the data-changing endpoints, and
 *   - it may not be the advancement save, which is the project's one write
 *     and must never be reachable from the sign-in path.
 *
 * The action is HTML we fetched, so it is untrusted input; this is what keeps
 * a doctored page from turning "enter your code" into a destructive request.
 */
function guardChallenge(pathname) {
  if (FORBIDDEN_PATH_RE.test(pathname)) {
    fail(EXIT.CONFIG, `refusing to post the sign-in code to ${pathname} — that endpoint changes data`);
  }
  if (pathname === '/advancement/index') {
    fail(EXIT.CONFIG, 'refusing to post the sign-in code to the advancement save');
  }
}

// ------------------------------------------------------------ cookie jar ---
// Hand-rolled: keep every cookie the site sets, honour deletions (empty
// value, Max-Age<=0, or an Expires date in the past), last write wins.
class CookieJar {
  constructor() { this.map = new Map(); }

  absorbLines(lines) {
    for (const line of lines || []) {
      if (!line) continue;
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      let del = value === '';
      for (const attr of attrs) {
        const j = attr.indexOf('=');
        const key = (j < 0 ? attr : attr.slice(0, j)).trim().toLowerCase();
        const val = j < 0 ? '' : attr.slice(j + 1).trim();
        if (key === 'max-age' && Number(val) <= 0) del = true;
        if (key === 'expires') {
          const d = new Date(val);
          if (!Number.isNaN(d.getTime()) && d.getTime() < Date.now()) del = true;
        }
      }
      if (del) this.map.delete(name); else this.map.set(name, value);
    }
  }

  absorb(res) {
    const lines = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [].concat(res.headers.get('set-cookie') || []);
    this.absorbLines(lines);
  }

  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  lines() { return [...this.map].map(([k, v]) => `${k}=${v}`); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

// ---------------------------------------------------------------- config ---
function makeConfig(env = process.env) {
  return {
    email: env.TLC_EMAIL || '',
    password: env.TLC_PASSWORD || '',
    base: (env.TLC_BASE || 'https://www.traillifeconnect.com').replace(/\/$/, ''),
    loginPath: env.TLC_LOGIN_PATH || '/login',
    probePath: env.TLC_PROBE_PATH || '',
    // Escape hatches: the code form is found by shape, so these stay empty
    // unless the portal renders something the detector cannot see.
    mfaField: env.TLC_MFA_FIELD || '',
    mfaPath: env.TLC_MFA_PATH || '',
    throttleMs: env.TLC_THROTTLE_MS !== undefined && env.TLC_THROTTLE_MS !== ''
      ? Number(env.TLC_THROTTLE_MS) : 300,
    maxPages: Number(env.TLC_MAX_PAGES) > 0 ? Number(env.TLC_MAX_PAGES) : 20,
    userAgent: 'tl-service-stars/0.1 (+self-hosted troop tool; read-only)',
  };
}

// ------------------------------------------------- second-factor detection ---
// Found by SHAPE, never by hard-coded field names: a <form> with no password
// input (that would be the login form re-rendered after a bad password — a
// different failure) that holds a short free-text input whose name looks like
// a code field. Its hidden inputs (Yii's _csrf among them) travel verbatim,
// because reposting the form is exactly what a browser would do.
const CODE_FIELD_RE = /(^|[[\]_.\-])(code|otp|pin|token|mfa|2fa|twofactor|two_factor|authcode|verification|verifycode)/i;
const CODE_INPUT_TYPES = new Set(['text', 'tel', 'number', 'password', '']);

/** The sentence above the box ("We sent a code to ...") — display only. */
function challengePrompt(html) {
  const lines = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  for (const raw of lines.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length > 4 && line.length <= 200 && /\bcodes?\b/i.test(line)) return line;
  }
  return null;
}

/** {action, method, field, hidden, csrf, prompt} when `html` is a code prompt, else null. */
function parseChallenge(html, atPath, cfg = {}) {
  const page = String(html || '');
  if (!page) return null;
  if (/LoginForm\[password\]/.test(page)) return null; // the login form, not a code prompt
  for (const f of formsIn(page)) {
    const ins = inputsIn(f.body);
    if (ins.some((i) => i.type === 'password' && /pass(word|wd)/i.test(i.name))) continue;
    const field = cfg.mfaField
      ? ins.find((i) => i.name === cfg.mfaField)
      : ins.find((i) => i.type !== 'hidden' && CODE_INPUT_TYPES.has(i.type) && CODE_FIELD_RE.test(i.name));
    if (!field) continue;
    const hidden = {};
    for (const i of ins) if (i.type === 'hidden') hidden[i.name] = i.value;
    return {
      action: cfg.mfaPath || attrOf(f.attrs, 'action') || atPath || '',
      method: (attrOf(f.attrs, 'method') || 'POST').toUpperCase(),
      field: field.name,
      hidden,
      csrf: hidden._csrf || csrfFrom(page) || null,
      prompt: challengePrompt(page),
    };
  }
  return null;
}

// --------------------------------------------------------------- session ---
/**
 * A session store is injected so this module stays database-free.
 * Expected shape (all optional, all failures tolerated):
 *   loadCookies(base) -> string[] | null
 *   saveCookies(jar, base) -> void
 *   touch() -> void
 *   putChallenge({ base, cookies, challenge, prompt }) -> info
 *   clearChallenge() -> void
 */
const NO_STORE = {
  loadCookies: () => null, saveCookies: () => {}, touch: () => {},
  putChallenge: () => null, clearChallenge: () => {},
};
function safely(store, fn, fallback = null) {
  try { return fn(store); } catch { return fallback; }
}

// ---------------------------------------------------------------- client ---
/**
 * @param {object} cfg    makeConfig() output
 * @param {object} deps   { store, fetchImpl, sleep, log }
 */
function makeClient(cfg, { store = NO_STORE, fetchImpl = fetch, sleep = null, log = () => {} } = {}) {
  const jar = new CookieJar();
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastAt = 0;
  let csrf = null;

  async function throttle() {
    const gap = Date.now() - lastAt;
    if (lastAt && gap < cfg.throttleMs) await wait(cfg.throttleMs - gap);
    lastAt = Date.now();
  }

  // The raw transport. `unsafe: true` skips the read allow-list and is used
  // by exactly one caller (postAdvancementIndex); everything else is guarded.
  async function send(pathOrUrl, opts = {}, { unsafe = false, challenge = false } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : cfg.base + pathOrUrl;
    const parsed = new URL(url);
    const { pathname } = parsed;
    // The portal's own host only — a challenge action is untrusted HTML and
    // must never send our cookies somewhere else.
    if (parsed.origin !== new URL(cfg.base).origin) {
      fail(EXIT.CONFIG, `refusing to send portal cookies to ${parsed.origin}`);
    }
    if (challenge) guardChallenge(pathname);
    else if (!unsafe) guard(pathname, opts.method || 'GET');
    else if (FORBIDDEN_PATH_RE.test(pathname)) {
      fail(EXIT.CONFIG, `refusing ${pathname} — that endpoint changes data on Trail Life Connect`);
    }
    await throttle();
    const baseHeaders = () => ({
      'User-Agent': cfg.userAgent,
      'Accept-Language': 'en-US,en;q=0.9',
      ...(jar.size ? { Cookie: jar.header() } : {}),
      ...(opts.headers || {}),
    });
    let res = await fetchImpl(url, { ...opts, headers: baseHeaders(), redirect: 'manual' });
    jar.absorb(res);
    let hops = 0;
    let from = url;
    while (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops++ < 5) {
      const next = new URL(res.headers.get('location'), from).toString();
      if (!unsafe && !challenge) guard(new URL(next).pathname, 'GET');
      const h = baseHeaders();
      delete h['Content-Type']; // never re-send POST headers on the redirect GET
      h.Cookie = jar.header();
      res = await fetchImpl(next, { headers: h, redirect: 'manual' });
      jar.absorb(res);
      from = next;
    }
    return res;
  }

  async function getText(path) {
    const res = await send(path);
    const html = await res.text();
    if (res.status >= 400) fail(EXIT.FETCH, `GET ${path.split('?')[0]} returned ${res.status}`);
    return html;
  }

  /** Is a restored jar still signed in? Returns the page CSRF token, or null. */
  async function probeSession() {
    const at = cfg.probePath || cfg.loginPath;
    let res;
    try { res = await send(at); } catch { return null; }
    if (res.status >= 400) { await res.text().catch(() => {}); return null; }
    const html = await res.text();
    if (/LoginForm\[password\]/.test(html)) return null;   // bounced to the form
    if (parseChallenge(html, at, cfg)) return null;        // half-authenticated
    return csrfFrom(html);
  }

  /**
   * Sign in, reusing the stored session when there is one.
   * @param {{useStored?: boolean, park?: boolean}} opts
   * @throws TlcError(6) with `.challenge` when the portal wants a code.
   */
  async function login(opts = {}) {
    if (opts.useStored !== false) {
      const lines = safely(store, (s) => s.loadCookies(cfg.base));
      if (lines && lines.length) {
        jar.absorbLines(lines);
        const token = await probeSession();
        if (token) { safely(store, (s) => s.touch()); csrf = token; return token; }
        jar.clear(); // expired: never carry its cookies into a fresh sign-in
      }
    }
    if (!cfg.email || !cfg.password) fail(EXIT.CONFIG, 'No Trail Life Connect credentials are saved.');

    const html = await getText(cfg.loginPath);
    const token = csrfFrom(html);
    if (!token) fail(EXIT.AUTH, 'Could not find the _csrf token on the sign-in page — the form may have changed.');

    const res = await send(cfg.loginPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: cfg.base,
        Referer: cfg.base + cfg.loginPath,
      },
      body: new URLSearchParams({
        _csrf: token,
        'LoginForm[email]': cfg.email,
        'LoginForm[password]': cfg.password,
        'LoginForm[rememberMe]': '1',
      }).toString(),
    });
    const after = await res.text();

    // Second factor. The password was accepted; the portal wants the code it
    // just texted. Park it and STOP — never retried on a timer, because every
    // attempt sends the human another message.
    const challenge = parseChallenge(after, cfg.loginPath, cfg);
    if (challenge) {
      const parked = opts.park === false ? null : safely(store, (s) => s.putChallenge({
        base: cfg.base, cookies: jar.lines(), challenge, prompt: challenge.prompt,
      }));
      const e = new TlcError(EXIT.CODE_REQUIRED,
        `Trail Life Connect asked for a sign-in code${challenge.prompt ? ` — ${challenge.prompt}` : ''}. `
        + 'Open Settings -> Trail Life Connect and enter it there; syncs resume once the session is connected.');
      e.challenge = challenge;
      e.parked = parked;
      throw e;
    }
    if (/LoginForm\[password\]/.test(after)) {
      fail(EXIT.AUTH, 'Sign-in rejected. Check the credentials — do NOT retry in a loop, the portal may lock the account.');
    }
    safely(store, (s) => s.saveCookies(jar, cfg.base));
    csrf = csrfFrom(after) || token;
    return csrf;
  }

  /**
   * Finish a parked sign-in with the code a human typed.
   * @throws TlcError(7) with a refreshed `.challenge` when the code is refused.
   */
  async function submitChallenge(challenge, code) {
    const value = String(code || '').trim();
    if (!value) fail(EXIT.CODE_REJECTED, 'Enter the code the portal sent.');
    if (challenge.cookies) jar.absorbLines(challenge.cookies);

    const fields = { ...(challenge.hidden || {}) };
    if (challenge.csrf && !fields._csrf) fields._csrf = challenge.csrf;
    fields[challenge.field] = value;

    const action = challenge.action || cfg.loginPath;
    const res = await send(action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: cfg.base,
        Referer: action.startsWith('http') ? action : cfg.base + action,
        ...(fields._csrf ? { 'X-CSRF-Token': fields._csrf } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    }, { challenge: true });
    const html = await res.text();
    if (res.status >= 400) {
      fail(EXIT.CODE_REJECTED, `The portal refused the code form (status ${res.status}) — start the sign-in again to get a fresh code.`);
    }
    const again = parseChallenge(html, action, cfg);
    if (again) {
      const e = new TlcError(EXIT.CODE_REJECTED,
        'That code was not accepted — check the digits and try again. If it has expired, start a new sign-in.');
      e.challenge = again;
      throw e;
    }
    if (/LoginForm\[password\]/.test(html)) {
      fail(EXIT.AUTH, 'The portal sent us back to the sign-in form — start the sign-in again.');
    }
    safely(store, (s) => s.saveCookies(jar, cfg.base));
    safely(store, (s) => s.clearChallenge());
    csrf = csrfFrom(html);
    return csrf;
  }

  // ------------------------------------------------------------- reads ----
  /** The troop's trailmen, from #trailmen-select on /advancement/index. */
  async function fetchTrailmen() {
    const html = await getText('/advancement/index');
    if (!csrf) csrf = csrfFrom(html);
    return parseTrailmenIndex(html);
  }

  /**
   * One trailman's service ledger and awards grid, PAGED until complete.
   *
   * The ledger shows at most 100 rows and renders no pager, but its footer
   * states the true count — so we follow ?page=N until the rows we have match
   * that count. Returns `ledger.complete === false` if we ran out of pages;
   * the caller must not propose stars off a partial read.
   */
  async function fetchTrailmanService(trailmanId) {
    if (!/^u[a-z0-9]{11}$/.test(String(trailmanId || ''))) {
      fail(EXIT.CONFIG, 'fetchTrailmanService needs a trailman hashid');
    }
    const first = parseProfileService(await getText(`/profile/${trailmanId}?tab=service`));
    const pages = [first.ledger];
    const warnings = [...first.warnings];
    let guardCount = 1;
    while (
      first.ledger.declaredRows !== null
      && mergeLedgerPages(pages).rows.length < first.ledger.declaredRows
      && guardCount < cfg.maxPages
    ) {
      guardCount += 1;
      const next = parseProfileService(await getText(`/profile/${trailmanId}?tab=service&page=${guardCount}`));
      // A page that adds nothing means the portal stopped honouring ?page=
      // — stop rather than loop, and let `complete` report the shortfall.
      const before = mergeLedgerPages(pages).rows.length;
      pages.push(next.ledger);
      if (mergeLedgerPages(pages).rows.length === before) {
        warnings.push(`ledger: page ${guardCount} added no rows — stopping, the read is partial`);
        break;
      }
      if (!next.ledger.rows.length) break;
    }
    const ledger = mergeLedgerPages(pages);
    if (!ledger.complete) {
      warnings.push(`ledger: ${ledger.rows.length} of ${ledger.declaredRows} records read after ${guardCount} page(s)`);
    }
    return {
      trailmanId: first.trailmanId || trailmanId,
      ledger,
      awards: first.awards,
      stars: first.stars,
      pagesRead: guardCount,
      warnings,
    };
  }

  /**
   * The Standard-view fragment for one trailman + one award — the form the
   * push echoes back. Read-only.
   */
  async function fetchBadgeTrackerView({ trailmanId, awardId, level }) {
    const body = new URLSearchParams();
    body.set('_csrf', csrf || '');
    body.set('style-select', 'standard');
    if (level) body.set('level-select', level);
    body.append('trailmen-select[]', trailmanId);
    body.set('badge-select', awardId);
    const res = await send('/advancement/badge-tracker-view', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        Origin: cfg.base,
        Referer: `${cfg.base}/advancement/index`,
      },
      body: body.toString(),
    });
    const html = await res.text();
    if (res.status >= 400) fail(EXIT.FETCH, `badge-tracker-view returned ${res.status}`);
    return html;
  }

  // ------------------------------------------------------------- write ----
  /**
   * THE ONE WRITE. Deliberately not reachable through the read allow-list:
   * only server/lib/starspush.js calls this, only while `push_enabled` is on,
   * and every save is proved by read-back (an HTTP 200 here means nothing —
   * this platform answers 200 whether or not it wrote).
   */
  async function postAdvancementIndex(fields) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (Array.isArray(v)) for (const one of v) body.append(k, one);
      else if (v !== null && v !== undefined) body.append(k, String(v));
    }
    if (!body.has('_csrf') && csrf) body.set('_csrf', csrf);
    const res = await send('/advancement/index', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: cfg.base,
        Referer: `${cfg.base}/advancement/index`,
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
      body: body.toString(),
    }, { unsafe: true });
    const html = await res.text();
    if (res.status >= 400) fail(EXIT.FETCH, `advancement save returned ${res.status}`);
    return html;
  }

  return {
    cfg,
    jar,
    get csrf() { return csrf; },
    set csrf(v) { csrf = v; },
    login,
    submitChallenge,
    probeSession,
    fetchTrailmen,
    fetchTrailmanService,
    fetchBadgeTrackerView,
    postAdvancementIndex,
    getText,
    _send: send,
  };
}

module.exports = {
  TlcError, EXIT, CookieJar, makeConfig, makeClient,
  parseChallenge, challengePrompt, guard, guardChallenge,
  ALLOWED_PATHS, ALLOWED_PATTERNS, FORBIDDEN_PATH_RE, PAGE_CAP,
};

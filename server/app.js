'use strict';
/**
 * app.js — routes. Everything below /api is JSON; everything else is the
 * single-page UI in public/.
 *
 * CSRF: the session cookie is SameSite=Lax, and every mutating route demands
 * both a JSON body and an `X-Requested-With: tl-service-stars` header. A
 * cross-site <form> can send neither, and a cross-site fetch cannot add the
 * header without a preflight that this server never approves (there is no
 * CORS handler at all — same-origin only).
 */
const express = require('express');
const path = require('path');
const { db } = require('./db');
const env = require('./lib/env');
const auth = require('./lib/auth');
const users = require('./lib/users');
const icon = require('../lib/icon');
const sync = require('./lib/sync');
const push = require('./lib/starspush');
const portal = require('./lib/portalsession');
const tlcLib = require('../lib/tlc');
const { getSetting, setSetting, allSettings, audit } = require('./lib/settings');
const { formatHundredths } = require('../lib/service');
const { STAR_LEVELS } = require('../lib/program');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ------------------------------------------------------------- utilities ---
/** Tiny cookie reader — one cookie, no dependency. */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const XRW = 'tl-service-stars';
function requireXhr(req, res, next) {
  if (req.get('X-Requested-With') !== XRW) return res.status(403).json({ error: 'bad request origin' });
  return next();
}

/** Wrap an async handler so a rejection becomes a 500 rather than a hang. */
const aw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const actorOf = (req) => (req.user ? req.user.email : null);

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(express.json({ limit: '128kb' }));
  app.use((req, res, next) => { req.cookies = parseCookies(req.headers.cookie); next(); });
  app.use(auth.attachUser);

  // ------------------------------------------------------------- icons ----
  app.get('/icon.svg', (req, res) => {
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(icon.iconSvg());
  });
  for (const size of [192, 512]) {
    app.get(`/icon-${size}.png`, (req, res) => {
      res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(icon.iconPng(size));
    });
  }
  // Browsers ask for /favicon.ico unprompted; a 32px PNG under that name is
  // served happily by every current browser.
  app.get('/favicon.ico', (req, res) => {
    res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(icon.iconPng(32));
  });
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').json({
      name: `${env.TROOP_NAME} Service Stars`,
      short_name: 'Service Stars',
      start_url: '/',
      display: 'standalone',
      background_color: icon.PINE,
      theme_color: icon.PINE,
      icons: [
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  });

  // ------------------------------------------------------------- health ---
  app.get('/health', (req, res) => {
    const session = portal.sessionInfo();
    const last = db.prepare("SELECT * FROM run WHERE kind = 'sync' ORDER BY id DESC LIMIT 1").get();
    res.json({
      ok: true,
      app: 'tl-service-stars',
      version: require('../package.json').version,
      troop: env.TROOP_ID,
      portal: { connected: session.connected, lastOkAt: session.last_ok_at },
      lastSync: last ? { at: last.started_at, ok: !!last.ok } : null,
      users: db.prepare('SELECT COUNT(*) AS n FROM app_user WHERE disabled_at IS NULL').get().n,
    });
  });

  // ---------------------------------------------------------- sign in/out --
  app.post('/api/signin', requireXhr, aw(async (req, res) => {
    const { email, password } = req.body || {};
    try {
      const { session, user } = await auth.signIn(email, password, { userAgent: req.get('User-Agent') });
      res.cookie(auth.COOKIE, session.id, auth.cookieOpts());
      res.json({ user });
    } catch (e) {
      res.status(e.status || 401).json({ error: e.message });
    }
  }));

  app.post('/api/signout', requireXhr, (req, res) => {
    if (req.cookies[auth.COOKIE]) auth.destroySession(req.cookies[auth.COOKIE]);
    res.clearCookie(auth.COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    // Never hand the session id back to the page: the cookie is httpOnly so
    // that a script cannot read it, and echoing it here would undo that.
    const { sid, ...user } = req.user;
    return res.json({
      user,
      troop: { id: env.TROOP_ID, name: env.TROOP_NAME },
      settings: req.user.role === 'admin' ? allSettings() : { push_enabled: getSetting('push_enabled') },
    });
  });

  // Reachable while must_change is set — it is the way out of that state.
  app.post('/api/password', requireXhr, auth.requireUser('leader', { allowMustChange: true }), aw(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    try {
      await auth.changeOwnPassword(req.user.id, currentPassword, newPassword);
      audit(actorOf(req), 'user.password_changed', 'app_user', req.user.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  }));

  // ------------------------------------------------------------ progress --
  /** The roster overview: one line per trailman. */
  app.get('/api/progress', auth.requireUser(), (req, res) => {
    const people = db.prepare('SELECT * FROM trailman WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
    const rows = people.map((p) => {
      const g = sync.progressFor(p);
      const levels = g.chain.levels.map((l) => ({
        level: l.level,
        hours: l.display.hours,
        onRecord: l.onRecord,
        expected: l.expected,
        newStars: l.newStars,
        toNext: l.display.toNext,
        pct: l.toNext.pct,
        conflict: l.conflict,
        legacyMode: l.legacyMode,
      }));
      return {
        id: p.id,
        name: p.name,
        levels,
        woodlands: g.sums.display.woodlands,
        newStars: g.chain.newStars,
        conflicts: g.chain.conflicts,
        proposals: g.proposals.length,
        records: g.serviceRows.length,
      };
    });
    res.json({ trailmen: rows, generatedAt: new Date().toISOString() });
  });

  app.get('/api/trailmen/:id', auth.requireUser(), (req, res) => {
    const p = db.prepare('SELECT * FROM trailman WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'no such trailman' });
    const g = sync.progressFor(p);
    return res.json({
      ...g,
      serviceRows: g.serviceRows.map((r) => ({
        recordId: r.record_id,
        date: r.date,
        description: r.description,
        hours: formatHundredths(r.hundredths),
        hundredths: r.hundredths,
        level: r.level,
        verified: r.verified,
        counts: STAR_LEVELS.includes(r.level) && r.verified === true,
      })),
    });
  });

  // ----------------------------------------------------------- proposals --
  app.get('/api/proposals', auth.requireUser(), (req, res) => {
    const status = req.query.status || 'proposed';
    const rows = db.prepare(
      `SELECT p.*, t.name AS trailman_name, t.id AS trailman_id
         FROM proposal p JOIN trailman t ON t.id = p.trailman_id
        WHERE p.status = ? ORDER BY t.name COLLATE NOCASE, p.level, p.ordinal`,
    ).all(status);
    res.json({ proposals: rows });
  });

  function decide(id, status, actor, note) {
    const p = db.prepare('SELECT * FROM proposal WHERE id = ?').get(id);
    if (!p) throw Object.assign(new Error('no such proposal'), { status: 404 });
    if (p.status === 'recorded') throw Object.assign(new Error('that star is already on the portal'), { status: 409 });
    db.prepare('UPDATE proposal SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?')
      .run(status, new Date().toISOString(), actor, note || null, id);
    audit(actor, `proposal.${status}`, 'proposal', id, { status: p.status }, { status });
    return db.prepare('SELECT * FROM proposal WHERE id = ?').get(id);
  }

  app.post('/api/proposals/:id/approve', requireXhr, auth.requireUser(), (req, res) => {
    try {
      const p = decide(req.params.id, 'approved', actorOf(req), (req.body || {}).note);
      // Approving queues it; nothing leaves the building until push_enabled.
      const queued = push.enqueue(p.id, actorOf(req));
      res.json({ proposal: p, queued, pushEnabled: !!getSetting('push_enabled') });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.post('/api/proposals/:id/reject', requireXhr, auth.requireUser(), (req, res) => {
    try {
      res.json({ proposal: decide(req.params.id, 'rejected', actorOf(req), (req.body || {}).note) });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  /** Undo a rejection — a rejected ordinal is otherwise never proposed again. */
  app.post('/api/proposals/:id/reopen', requireXhr, auth.requireUser(), (req, res) => {
    const p = db.prepare('SELECT * FROM proposal WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'no such proposal' });
    if (!['rejected', 'withdrawn'].includes(p.status)) {
      return res.status(409).json({ error: 'only a rejected or withdrawn star can be reopened' });
    }
    db.prepare("UPDATE proposal SET status = 'proposed', decided_at = NULL, decided_by = NULL, note = NULL WHERE id = ?")
      .run(p.id);
    audit(actorOf(req), 'proposal.reopen', 'proposal', p.id, { status: p.status }, { status: 'proposed' });
    return res.json({ proposal: db.prepare('SELECT * FROM proposal WHERE id = ?').get(p.id) });
  });

  // ------------------------------------------------------- legacy rulings --
  /**
   * How to treat stars a trailman holds that his counted hours do not
   * explain. This is a leader's judgement about history, so it is recorded
   * with who decided it (see lib/stars.js for what each mode does).
   */
  app.post('/api/trailmen/:id/legacy-mode', requireXhr, auth.requireUser(), (req, res) => {
    const { level, mode, freshFrom } = req.body || {};
    if (!STAR_LEVELS.includes(level)) return res.status(400).json({ error: 'unknown level' });
    if (!['separate', 'woodlands', 'fresh'].includes(mode)) return res.status(400).json({ error: 'unknown mode' });
    const row = db.prepare('SELECT * FROM star_baseline WHERE trailman_id = ? AND level = ?').get(req.params.id, level);
    if (!row) return res.status(404).json({ error: 'no baseline yet — run a sync first' });
    // 'fresh' restarts the level at the start of the current program year
    // (Trail Life years start in September) unless a date is given.
    let from = row.fresh_from;
    if (mode === 'fresh' && !from) {
      const now = new Date();
      const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
      from = freshFrom || `${year}-09-01`;
    }
    db.prepare('UPDATE star_baseline SET legacy_mode = ?, fresh_from = ?, decided_at = ?, decided_by = ? WHERE trailman_id = ? AND level = ?')
      .run(mode, mode === 'fresh' ? from : null, new Date().toISOString(), actorOf(req), req.params.id, level);
    audit(actorOf(req), 'baseline.legacy_mode', 'star_baseline', `${req.params.id}/${level}`,
      { mode: row.legacy_mode }, { mode, freshFrom: from });
    // Re-reconcile at once so the leader sees the effect immediately.
    const p = db.prepare('SELECT * FROM trailman WHERE id = ?').get(req.params.id);
    const g = sync.progressFor(p);
    sync.reconcileProposals(p.id, g.chain, g.serviceRows.map((r) => ({
      ...r, verified: r.verified === true || r.verified === 1,
    })), actorOf(req));
    return res.json({ ok: true, chain: sync.progressFor(p).chain });
  });

  // ------------------------------------------------------------- syncing --
  app.post('/api/sync', requireXhr, auth.requireUser(), aw(async (req, res) => {
    const result = await sync.runSync({ trigger: 'manual', actor: actorOf(req) });
    res.status(result.ok ? 200 : 502).json(result);
  }));

  app.get('/api/runs', auth.requireUser(), (req, res) => {
    const rows = db.prepare('SELECT * FROM run ORDER BY id DESC LIMIT 30').all().map((r) => ({
      ...r,
      summary: safeJson(r.summary),
      warnings: safeJson(r.warnings) || [],
    }));
    res.json({ runs: rows });
  });

  // -------------------------------------------------------------- portal --
  app.get('/api/portal', auth.requireUser('admin'), (req, res) => {
    res.json({
      base: env.TLC_BASE,
      enabled: env.TLC_ENABLED,
      credentials: portal.credentialsInfo(),
      session: portal.sessionInfo(),
      challenge: portal.challengeInfo(),
    });
  });

  app.post('/api/portal/credentials', requireXhr, auth.requireUser('admin'), (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'e-mail and password are both required' });
    try {
      portal.saveCredentials({ email: String(email).trim(), password: String(password) });
    } catch (e) {
      return res.status(500).json({ error: `could not store the credentials: ${e.message}` });
    }
    audit(actorOf(req), 'portal.credentials_saved', 'vault', 'portal_credentials', null, { email });
    return res.json({ credentials: portal.credentialsInfo() });
  });

  /** Start a portal sign-in. Answers 202 with a challenge when a code is wanted. */
  app.post('/api/portal/connect', requireXhr, auth.requireUser('admin'), aw(async (req, res) => {
    const tlc = sync.makeTlc();
    try {
      await tlc.login({ useStored: false });
      audit(actorOf(req), 'portal.connected', 'vault', 'portal_session');
      res.json({ connected: true, session: portal.sessionInfo() });
    } catch (e) {
      if (e.code === tlcLib.EXIT.CODE_REQUIRED) {
        return res.status(202).json({ codeRequired: true, message: e.message, challenge: portal.challengeInfo() });
      }
      return res.status(502).json({ error: e.message });
    }
  }));

  app.post('/api/portal/code', requireXhr, auth.requireUser('admin'), aw(async (req, res) => {
    const parked = portal.getChallenge((req.body || {}).id);
    if (!parked) return res.status(410).json({ error: 'that sign-in has expired — start it again to get a fresh code' });
    const tlc = sync.makeTlc();
    try {
      await tlc.submitChallenge(parked.challenge ? { ...parked.challenge, cookies: parked.cookies } : parked, (req.body || {}).code);
      audit(actorOf(req), 'portal.code_accepted', 'vault', 'portal_session');
      return res.json({ connected: true, session: portal.sessionInfo() });
    } catch (e) {
      return res.status(e.code === tlcLib.EXIT.CODE_REJECTED ? 400 : 502)
        .json({ error: e.message, challenge: portal.challengeInfo() });
    }
  }));

  app.post('/api/portal/disconnect', requireXhr, auth.requireUser('admin'), (req, res) => {
    portal.clearSession();
    portal.clearChallenge();
    audit(actorOf(req), 'portal.disconnected', 'vault', 'portal_session');
    res.json({ session: portal.sessionInfo() });
  });

  // ---------------------------------------------------------------- push --
  app.get('/api/push', auth.requireUser('admin'), (req, res) => {
    res.json({ enabled: !!getSetting('push_enabled'), queue: push.queueView() });
  });

  app.post('/api/push/enabled', requireXhr, auth.requireUser('admin'), (req, res) => {
    const on = !!(req.body || {}).enabled;
    setSetting('push_enabled', on, actorOf(req));
    audit(actorOf(req), 'push.enabled', 'setting', 'push_enabled', null, { enabled: on });
    res.json({ enabled: on });
  });

  app.post('/api/push/run', requireXhr, auth.requireUser('admin'), aw(async (req, res) => {
    const result = await push.runPush({ trigger: 'manual', actor: actorOf(req) });
    res.status(result.ok ? 200 : 409).json(result);
  }));

  for (const [action, fn] of [['requeue', push.requeue], ['cancel', push.cancel]]) {
    app.post(`/api/push/:id/${action}`, requireXhr, auth.requireUser('admin'), (req, res) => {
      try { res.json({ row: fn(Number(req.params.id), actorOf(req)) }); } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
  }

  // --------------------------------------------------------------- users --
  app.get('/api/users', auth.requireUser('admin'), (req, res) => res.json({ users: users.listUsers() }));

  app.post('/api/users', requireXhr, auth.requireUser('admin'), aw(async (req, res) => {
    try { res.json(await users.createUser(req.body || {}, actorOf(req))); } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  }));

  app.post('/api/users/:id', requireXhr, auth.requireUser('admin'), (req, res) => {
    try { res.json({ user: users.updateUser(Number(req.params.id), req.body || {}, actorOf(req)) }); } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.post('/api/users/:id/reset', requireXhr, auth.requireUser('admin'), aw(async (req, res) => {
    try { res.json(await users.resetPassword(Number(req.params.id), actorOf(req))); } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  }));

  for (const [action, arg] of [['disable', true], ['enable', false]]) {
    app.post(`/api/users/:id/${action}`, requireXhr, auth.requireUser('admin'), (req, res) => {
      try { res.json({ user: users.setDisabled(Number(req.params.id), arg, actorOf(req)) }); } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
      }
    });
  }

  app.post('/api/users/:id/unlock', requireXhr, auth.requireUser('admin'), (req, res) => {
    try { res.json({ user: users.unlock(Number(req.params.id), actorOf(req)) }); } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // ------------------------------------------------------------ settings --
  app.post('/api/settings', requireXhr, auth.requireUser('admin'), (req, res) => {
    const allowed = ['auto_propose', 'push_comment'];
    const out = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!allowed.includes(k)) continue;
      setSetting(k, k === 'push_comment' ? String(v).slice(0, 250) : !!v, actorOf(req));
      out[k] = getSetting(k);
    }
    audit(actorOf(req), 'settings.update', 'setting', null, null, out);
    res.json({ settings: allSettings() });
  });

  app.get('/api/audit', auth.requireUser('admin'), (req, res) => {
    res.json({ entries: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all() });
  });

  // ----------------------------------------------------------------- SPA --
  // The worker script and the shell must NEVER be served from a stale HTTP
  // cache. A browser only learns a new version exists by re-fetching sw.js,
  // so caching it is how an installed app gets stranded on an old build —
  // which is exactly what happened to the check-in app on a Chromebook.
  const noStore = (res) => res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  app.get('/sw.js', (req, res) => {
    noStore(res);
    // Allow the worker to control the whole origin even though it is one file.
    res.set('Service-Worker-Allowed', '/');
    res.type('application/javascript').sendFile(path.join(PUBLIC_DIR, 'sw.js'));
  });

  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    noStore(res);
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error('[app]', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'something went wrong on the server' });
  });

  return app;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = { createApp, parseCookies, XRW };

'use strict';
/**
 * Minimal .env loader (no dependency). Values already in process.env win.
 *
 * Timezone: `TZ=America/New_York` in .env is applied HERE, before anything
 * constructs a Date, so "today" in a star's completed-on date is the troop's
 * today and not UTC's.
 */
const fs = require('fs');
const path = require('path');

const ENV_PATH = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.join(__dirname, '..', '..', '.env');

try {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — defaults apply */ }

const bool = (v, dflt = false) => (v === undefined || v === '' ? dflt : String(v).toLowerCase() === 'true');

// Live getters (not a snapshot) so late changes — tests, systemd drop-ins —
// are always honoured.
module.exports = {
  ENV_PATH,
  get PORT() { return Number(process.env.PORT) || 3200; },
  get HOST() { return process.env.HOST || '127.0.0.1'; },
  get DATA_DIR() { return process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'); },
  get TROOP_ID() { return process.env.TROOP_ID || 'NY-0000'; },
  get TROOP_NAME() { return process.env.TROOP_NAME || 'Trail Life Troop'; },
  /** Public HTTPS origin the Cloudflare tunnel fronts, e.g. https://stars.example.org. */
  get PUBLIC_URL() { return (process.env.PUBLIC_URL || '').replace(/\/$/, ''); },

  // --- Trail Life Connect -------------------------------------------------
  get TLC_ENABLED() { return bool(process.env.TLC_ENABLED, true); },
  get TLC_BASE() { return (process.env.TLC_BASE || 'https://www.traillifeconnect.com').replace(/\/$/, ''); },
  get TLC_EMAIL() { return process.env.TLC_EMAIL || ''; },
  get TLC_PASSWORD() { return process.env.TLC_PASSWORD || ''; },

  // --- sign-in ------------------------------------------------------------
  /** Session cookie lifetime in days. */
  get SESSION_DAYS() { return Number(process.env.SESSION_DAYS) > 0 ? Number(process.env.SESSION_DAYS) : 14; },
  /** Bootstrap/recovery admins: these e-mails are admins whatever the DB says. */
  get ADMIN_EMAILS() {
    return String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  },
  /** true only behind a proxy that terminates TLS (the tunnel does). */
  get TRUST_PROXY() { return bool(process.env.TRUST_PROXY, true); },
  /** Set false only for plain-HTTP local development. */
  get SECURE_COOKIES() { return bool(process.env.SECURE_COOKIES, true); },

  // --- scheduling ---------------------------------------------------------
  /** 'nightly' (default) | 'off' — the read sync from TLC. */
  get SCHEDULE_SYNC() { return (process.env.SCHEDULE_SYNC || 'nightly').toLowerCase(); },
  /** Dev switch: skip every background job. Never set on the Pi. */
  get DISABLE_SCHEDULER() { return bool(process.env.DISABLE_SCHEDULER, false); },
};

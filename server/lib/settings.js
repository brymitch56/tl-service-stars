'use strict';
// Runtime config an admin can change, JSON-encoded in the `setting` table.
const { db } = require('../db');

const DEFAULTS = {
  // The TLC push ships OFF. A human flips it and watches the first run.
  push_enabled: false,
  // Propose stars automatically on every sync (they still need approval).
  auto_propose: true,
  // Comment written onto each pushed star instance, for provenance on TLC.
  push_comment: 'Recorded by the troop Service Star tracker',
};

function getSetting(key, dflt = undefined) {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key);
  if (!row) return dflt !== undefined ? dflt : DEFAULTS[key];
  try { return JSON.parse(row.value); } catch { return dflt !== undefined ? dflt : DEFAULTS[key]; }
}

function setSetting(key, value, actor = null) {
  db.prepare(`INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(key, JSON.stringify(value), new Date().toISOString(), actor);
  return value;
}

/** Every setting, defaults filled in — what the admin page renders. */
function allSettings() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM setting').all()) {
    try { out[r.key] = JSON.parse(r.value); } catch { /* keep the default */ }
  }
  return out;
}

function audit(actor, action, entity, entityId, before, after) {
  db.prepare(`INSERT INTO audit_log (at, actor, action, entity, entity_id, before, after)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), actor, action, entity || null,
      entityId === null || entityId === undefined ? null : String(entityId),
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after));
}

module.exports = { DEFAULTS, getSetting, setSetting, allSettings, audit };

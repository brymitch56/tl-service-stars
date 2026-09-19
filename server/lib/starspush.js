'use strict';
/**
 * starspush.js — THE ONLY MODULE THAT WRITES TO TRAIL LIFE CONNECT.
 *
 * It records approved Service Stars as new advancement instances via
 * `POST /advancement/index`, reached only through lib/tlc.js's
 * `postAdvancementIndex` — which is deliberately outside the read-only
 * allow-list, so `request()` still refuses a write everywhere else.
 *
 * The rules this module exists to enforce:
 *
 *   - IT SHIPS OFF. `push_enabled` defaults to false. A human turns it on and
 *     watches the first run.
 *   - ONE AT A TIME. Slot ids are minted per fetch of the Standard fragment,
 *     so two saves built from one fetch would collide. Every row re-fetches.
 *   - ECHO EVERYTHING. The save replaces the whole form; a field left out is
 *     a field cleared. lib/standard.js rebuilds the payload with exactly one
 *     slot filled.
 *   - A 200 PROVES NOTHING. This platform answers 200 whether or not it
 *     wrote, and validates almost nothing (a nonsense date is accepted and
 *     produces a dateless record). The only proof is a READ-BACK: re-read the
 *     profile and check the instance count for that level went up by one.
 *   - NEVER RETRY AN UNCONFIRMED SAVE. If the read-back does not confirm, the
 *     row goes to `held` for a human. A blind retry is how you create a
 *     duplicate star that someone then has to delete by hand.
 *   - VALIDATE THE DATE OURSELVES, because the portal will not.
 */
const { db } = require('../db');
const { toPortalDate, parseTlcDate } = require('../../lib/html');
const { parseStandardFragment, firstEmptySlot } = require('../../lib/standard');
const { STAR_AWARD_IDS, PROGRAM_OF, LEVEL_IDS, STAR_LEVELS } = require('../../lib/program');
const { getSetting, audit } = require('./settings');
const sync = require('./sync');

const nowIso = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('en-CA');

class PushError extends Error {
  constructor(msg, { held = false } = {}) { super(msg); this.held = held; }
}

// ----------------------------------------------------------------- queue ---
/**
 * Queue an approved proposal for the portal. Idempotent: a proposal already
 * waiting or already confirmed is not queued twice.
 */
function enqueue(proposalId, actor) {
  const p = db.prepare('SELECT * FROM proposal WHERE id = ?').get(proposalId);
  if (!p) throw new PushError('No such proposal.');
  if (p.status !== 'approved') throw new PushError('Only an approved star can be queued for the portal.');
  const open = db.prepare(
    "SELECT * FROM push_queue WHERE proposal_id = ? AND state IN ('queued','sent','confirmed','held')",
  ).get(proposalId);
  if (open) return open;
  const comment = String(getSetting('push_comment') || '').slice(0, 250);
  const info = db.prepare(
    `INSERT INTO push_queue (proposal_id, trailman_id, level, completed_on, comment, state, queued_at, queued_by)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(proposalId, p.trailman_id, p.level, p.completed_on || today(), comment, nowIso(), actor);
  audit(actor, 'push.enqueue', 'proposal', proposalId, null, { level: p.level, ordinal: p.ordinal });
  return db.prepare('SELECT * FROM push_queue WHERE id = ?').get(info.lastInsertRowid);
}

/** Put a held row back in the queue after a human has looked at the portal. */
function requeue(queueId, actor) {
  const row = db.prepare('SELECT * FROM push_queue WHERE id = ?').get(queueId);
  if (!row) throw new PushError('No such queue row.');
  if (!['held', 'failed'].includes(row.state)) throw new PushError('Only a held or failed row can be requeued.');
  db.prepare("UPDATE push_queue SET state = 'queued', detail = NULL WHERE id = ?").run(queueId);
  audit(actor, 'push.requeue', 'push_queue', queueId, { state: row.state }, { state: 'queued' });
  return db.prepare('SELECT * FROM push_queue WHERE id = ?').get(queueId);
}

function cancel(queueId, actor) {
  const row = db.prepare('SELECT * FROM push_queue WHERE id = ?').get(queueId);
  if (!row) throw new PushError('No such queue row.');
  if (row.state === 'confirmed') throw new PushError('That star is already recorded on the portal.');
  db.prepare("UPDATE push_queue SET state = 'cancelled' WHERE id = ?").run(queueId);
  audit(actor, 'push.cancel', 'push_queue', queueId, { state: row.state }, { state: 'cancelled' });
  return db.prepare('SELECT * FROM push_queue WHERE id = ?').get(queueId);
}

// ------------------------------------------------------------ validation ---
/** The portal accepts nonsense dates and stores them as nothing. We do not. */
function validateDate(iso) {
  const d = parseTlcDate(iso);
  if (!d) return 'the completed-on date is unreadable';
  if (d > today()) return `the completed-on date (${d}) is in the future`;
  if (d < '2000-01-01') return `the completed-on date (${d}) is implausibly old`;
  return null;
}

// --------------------------------------------------------------- one row ---
/**
 * Write one queued star and prove it. Returns the updated queue row.
 * Throws PushError only for problems that should stop the whole run
 * (auth, configuration); per-row problems land in the row's state.
 */
async function pushOne(tlc, row, actor) {
  const person = db.prepare('SELECT * FROM trailman WHERE id = ?').get(row.trailman_id);
  const held = (why) => {
    db.prepare("UPDATE push_queue SET state = 'held', attempts = attempts + 1, detail = ? WHERE id = ?")
      .run(why, row.id);
    return { ...row, state: 'held', detail: why };
  };
  const failed = (why) => {
    db.prepare("UPDATE push_queue SET state = 'failed', attempts = attempts + 1, detail = ? WHERE id = ?")
      .run(why, row.id);
    return { ...row, state: 'failed', detail: why };
  };

  if (!person) return failed('the trailman is no longer in the mirror');
  if (!STAR_LEVELS.includes(row.level)) return failed(`unknown level ${row.level}`);
  const dateProblem = validateDate(row.completed_on);
  if (dateProblem) return failed(dateProblem);

  const awardId = STAR_AWARD_IDS[row.level];
  const before = await tlc.fetchTrailmanService(person.tlc_user_id);
  const countBefore = before.stars[row.level] || 0;

  // Fetch the Standard fragment FRESH — slot ids are per-fetch.
  const fragment = await tlc.fetchBadgeTrackerView({
    trailmanId: person.tlc_user_id,
    awardId,
    level: LEVEL_IDS[row.level],
  });
  const parsed = parseStandardFragment(fragment);
  if (parsed.warnings.length) return held(`could not read the entry form: ${parsed.warnings.join('; ')}`);

  const slot = firstEmptySlot(parsed);
  if (!slot) return held('the portal offered no empty slot for another instance — add it by hand');

  db.prepare("UPDATE push_queue SET state = 'sent', attempts = attempts + 1, sent_at = ? WHERE id = ?")
    .run(nowIso(), row.id);

  const fields = require('../../lib/standard').toFields(parsed, {
    adId: slot.adId,
    completedOn: toPortalDate(row.completed_on),
    comment: row.comment || '',
    purchased: slot.purchased || '0',
  }, {
    _csrf: tlc.csrf || parsed.others._csrf || '',
    'style-select': 'standard',
    'level-select': LEVEL_IDS[row.level],
    'trailmen-select[]': person.tlc_user_id,
    'badge-select': awardId,
  });

  await tlc.postAdvancementIndex(fields);

  // A 200 means nothing here. Read it back.
  const after = await tlc.fetchTrailmanService(person.tlc_user_id);
  const countAfter = after.stars[row.level] || 0;
  sync.mirrorTrailman(person.id, after);

  if (countAfter !== countBefore + 1) {
    const why = `not confirmed by read-back: ${row.level} instances went ${countBefore} -> ${countAfter}`;
    audit(actor, 'push.held', 'push_queue', row.id, null, { why });
    return held(why);
  }

  // Which instance is new? The one the mirror did not have before.
  const beforeIds = new Set(before.awards.rows.filter((a) => a.starLevel === row.level).map((a) => a.adId));
  const fresh = after.awards.rows.find((a) => a.starLevel === row.level && !beforeIds.has(a.adId));
  db.prepare("UPDATE push_queue SET state = 'confirmed', confirmed_at = ?, ad_id = ?, detail = NULL WHERE id = ?")
    .run(nowIso(), fresh ? fresh.adId : null, row.id);
  db.prepare("UPDATE proposal SET status = 'recorded', decided_at = ?, decided_by = ? WHERE id = ?")
    .run(nowIso(), actor || 'push', row.proposal_id);
  audit(actor, 'push.confirmed', 'push_queue', row.id, null, { level: row.level, adId: fresh ? fresh.adId : null });
  return { ...row, state: 'confirmed', ad_id: fresh ? fresh.adId : null };
}

// ------------------------------------------------------------------ run ----
/**
 * Drain the queue. Stops at the first auth/config failure — the portal locks
 * accounts, and a run that cannot sign in will not fix itself by continuing.
 */
async function runPush({ trigger = 'manual', actor = null, limit = 25, client = null } = {}) {
  const started = nowIso();
  const runId = db.prepare('INSERT INTO run (kind, started_at, trigger, actor) VALUES (?, ?, ?, ?)')
    .run('push', started, trigger, actor).lastInsertRowid;
  const warnings = [];
  const summary = { attempted: 0, confirmed: 0, held: 0, failed: 0 };

  const finish = (ok, err) => {
    db.prepare('UPDATE run SET finished_at = ?, ok = ?, summary = ?, warnings = ? WHERE id = ?')
      .run(nowIso(), ok ? 1 : 0, JSON.stringify(err ? { ...summary, error: err } : summary),
        JSON.stringify(warnings.slice(0, 200)), runId);
    return { runId, ok, summary, warnings, error: err || null };
  };

  if (!getSetting('push_enabled')) {
    return finish(false, 'Recording to Trail Life Connect is switched off (Settings → push).');
  }

  const rows = db.prepare("SELECT * FROM push_queue WHERE state = 'queued' ORDER BY queued_at LIMIT ?").all(limit);
  if (!rows.length) return finish(true, null);

  const tlc = client || sync.makeTlc();
  try {
    await tlc.login();
  } catch (e) {
    return finish(false, `Could not sign in to Trail Life Connect: ${e.message}`);
  }

  for (const row of rows) {
    summary.attempted += 1;
    let result;
    try {
      result = await pushOne(tlc, row, actor);
    } catch (e) {
      // An unexpected throw mid-save is exactly the case where we do not know
      // whether it wrote. Hold it; never retry automatically.
      const why = `error during the save: ${e.message}`;
      db.prepare("UPDATE push_queue SET state = 'held', attempts = attempts + 1, detail = ? WHERE id = ?")
        .run(why, row.id);
      summary.held += 1;
      warnings.push(`queue #${row.id}: ${why}`);
      continue;
    }
    if (result.state === 'confirmed') summary.confirmed += 1;
    else if (result.state === 'held') { summary.held += 1; warnings.push(`queue #${row.id}: ${result.detail}`); }
    else { summary.failed += 1; warnings.push(`queue #${row.id}: ${result.detail}`); }
  }
  audit(actor, 'push.run', 'run', runId, null, summary);
  return finish(true, null);
}

/** What the admin page renders. */
function queueView(limit = 100) {
  return db.prepare(
    `SELECT q.*, t.name AS trailman_name, p.ordinal
       FROM push_queue q
       JOIN trailman t ON t.id = q.trailman_id
       LEFT JOIN proposal p ON p.id = q.proposal_id
      ORDER BY q.state = 'queued' DESC, q.queued_at DESC LIMIT ?`,
  ).all(limit);
}

module.exports = {
  PushError, enqueue, requeue, cancel, validateDate, pushOne, runPush, queueView, PROGRAM_OF,
};

'use strict';
/**
 * sync.js — the read side: pull Trail Life Connect, mirror it, do the
 * arithmetic, and propose the stars the hours have earned.
 *
 * Nothing here writes to Trail Life Connect. Proposals are the output; a
 * leader approves them, and only then does server/lib/starspush.js (behind
 * `push_enabled`) record anything on the portal.
 *
 * REFUSING TO GUESS. A trailman whose ledger came back incomplete — the
 * 100-row cap beat us, or a row's hours would not parse — is mirrored but
 * NOT proposed against, and the run says so. Undercounted hours suppress
 * stars silently, which is the one failure mode nobody would notice.
 */
const { db } = require('../db');
const env = require('./env');
const tlcLib = require('../../lib/tlc');
const portal = require('./portalsession');
const { STAR_LEVELS, RATE_HUNDREDTHS } = require('../../lib/program');
const { formatHundredths, ledgerChecksum } = require('../../lib/service');
const {
  sumApprovedByLevel, countStarsOnRecord, computeStarChain, baselineFrom, starDates,
} = require('../../lib/stars');
const { getSetting, audit } = require('./settings');

const nowIso = () => new Date().toISOString();
/** Today in the troop's timezone (TZ is applied in lib/env). */
const today = () => new Date().toLocaleDateString('en-CA');

// --------------------------------------------------------------- client ----
/**
 * A signed-in TLC client. Credentials come from the database first (an admin
 * saved them in Settings) and fall back to .env.
 */
function makeTlc(overrides = {}) {
  const saved = portal.loadCredentials();
  const cfg = tlcLib.makeConfig({
    ...process.env,
    TLC_BASE: env.TLC_BASE,
    TLC_EMAIL: (saved && saved.email) || env.TLC_EMAIL,
    TLC_PASSWORD: (saved && saved.password) || env.TLC_PASSWORD,
    ...overrides,
  });
  // Diagnostics go to the journal; the client never logs a value.
  return tlcLib.makeClient(cfg, { store: portal, log: (m) => console.log(m) });
}

// --------------------------------------------------------------- mirror ----
function upsertTrailmen(list) {
  const at = nowIso();
  const ins = db.prepare(
    `INSERT INTO trailman (tlc_user_id, name, active, first_seen_at, last_seen_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(tlc_user_id) DO UPDATE SET name = excluded.name, active = 1, last_seen_at = excluded.last_seen_at`,
  );
  const seen = [];
  db.transaction(() => {
    for (const t of list) { ins.run(t.trailmanId, t.name, at, at); seen.push(t.trailmanId); }
    // Anyone the portal no longer lists goes inactive; his history stays.
    if (seen.length) {
      db.prepare(`UPDATE trailman SET active = 0
                   WHERE active = 1 AND tlc_user_id NOT IN (${seen.map(() => '?').join(',')})`).run(...seen);
    }
  })();
  return db.prepare('SELECT * FROM trailman WHERE active = 1 ORDER BY name COLLATE NOCASE').all();
}

/** Replace one trailman's mirrored ledger and star instances. */
function mirrorTrailman(trailmanId, { ledger, awards }) {
  const at = nowIso();
  db.transaction(() => {
    db.prepare('DELETE FROM service_row WHERE trailman_id = ?').run(trailmanId);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO service_row
         (trailman_id, record_id, date, description, hundredths, level, verified, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let i = 0;
    for (const r of ledger.rows) {
      i += 1;
      ins.run(trailmanId, r.recordId || `row-${i}`, r.date, r.description, r.hundredths, r.level,
        r.verified === true ? 1 : (r.verified === false ? 0 : null), at);
    }
    db.prepare('DELETE FROM star_instance WHERE trailman_id = ?').run(trailmanId);
    const insStar = db.prepare(
      `INSERT OR REPLACE INTO star_instance
         (trailman_id, ad_id, level, completed_on, awarded_on, purchased, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let j = 0;
    for (const a of awards.rows) {
      if (!a.starLevel) continue;
      j += 1;
      insStar.run(trailmanId, a.adId || `star-${j}`, a.starLevel, a.completedOn, a.awardedOn, a.purchased ? 1 : 0, at);
    }
  })();
}

// ------------------------------------------------------------- baseline ----
function loadBaseline(trailmanId) {
  const rows = db.prepare('SELECT * FROM star_baseline WHERE trailman_id = ?').all(trailmanId);
  if (!rows.length) return null;
  const out = {};
  for (const r of rows) {
    out[r.level] = {
      onRecord: r.on_record,
      earnable: r.earnable,
      hours: r.hundredths,
      legacyMode: r.legacy_mode,
      freshFrom: r.fresh_from,
    };
  }
  return out;
}

/** Capture the first-sync snapshot. Never overwrites an existing baseline. */
function captureBaseline(trailmanId, chain) {
  const snap = baselineFrom(chain);
  const at = nowIso();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO star_baseline
       (trailman_id, level, on_record, earnable, hundredths, legacy_mode, captured_at)
     VALUES (?, ?, ?, ?, ?, 'separate', ?)`,
  );
  db.transaction(() => {
    for (const level of STAR_LEVELS) ins.run(trailmanId, level, snap[level].onRecord, snap[level].earnable, snap[level].hours, at);
  })();
  return loadBaseline(trailmanId);
}

// ------------------------------------------------------------ proposals ----
/**
 * Reconcile proposals for one trailman against a freshly computed chain.
 *
 * Ordinals are absolute ("his 4th Navigator star"), so:
 *   - a star already on record retires its proposal as `recorded`;
 *   - a star the hours no longer support is `withdrawn`, not deleted;
 *   - a `rejected` ordinal is never proposed again — a leader's no is final
 *     until they clear it themselves.
 */
function reconcileProposals(trailmanId, chain, serviceRows, actor = 'sync') {
  const changes = { proposed: 0, withdrawn: 0, recorded: 0 };
  const at = nowIso();
  const existing = db.prepare('SELECT * FROM proposal WHERE trailman_id = ?').all(trailmanId);
  const byKey = new Map(existing.map((p) => [`${p.level}#${p.ordinal}`, p]));

  db.transaction(() => {
    for (const lvl of chain.levels) {
      const rows = serviceRows.filter((r) => r.level === lvl.level);
      // Which ordinals the arithmetic says should exist, and which are on record.
      const onRecord = lvl.onRecord;
      const expected = lvl.expected;
      const dates = starDates(rows, {
        rate: lvl.rate,
        startingHundredths: lvl.carryIn + lvl.credit,
        upTo: expected,
      });

      for (const p of existing.filter((x) => x.level === lvl.level)) {
        if (p.status === 'proposed' && p.ordinal <= onRecord) {
          db.prepare('UPDATE proposal SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
            .run('recorded', at, actor, p.id);
          changes.recorded += 1;
        } else if (p.status === 'proposed' && p.ordinal > expected) {
          db.prepare('UPDATE proposal SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?')
            .run('withdrawn', at, actor, 'the counted hours no longer support this star', p.id);
          changes.withdrawn += 1;
        }
      }

      for (let ord = onRecord + 1; ord <= expected; ord++) {
        const prior = byKey.get(`${lvl.level}#${ord}`);
        // A leader's rejection stands; a withdrawn one may come back.
        if (prior && ['rejected', 'approved', 'proposed'].includes(prior.status)) continue;
        const completedOn = dates[ord - 1] || today();
        if (prior) {
          db.prepare(`UPDATE proposal SET status = 'proposed', proposed_at = ?, completed_on = ?,
                        hundredths_at_proposal = ?, decided_at = NULL, decided_by = NULL, note = NULL WHERE id = ?`)
            .run(at, completedOn, lvl.available, prior.id);
        } else {
          db.prepare(`INSERT INTO proposal
             (trailman_id, level, ordinal, status, hundredths_at_proposal, completed_on, proposed_at)
             VALUES (?, ?, ?, 'proposed', ?, ?, ?)`)
            .run(trailmanId, lvl.level, ord, lvl.available, completedOn, at);
        }
        changes.proposed += 1;
      }
    }
  })();
  return changes;
}

/** Retire every open proposal for a trailman we can no longer trust the hours for. */
function holdProposals(trailmanId, why) {
  const at = nowIso();
  const n = db.prepare(
    `UPDATE proposal SET status = 'withdrawn', decided_at = ?, decided_by = 'sync', note = ?
      WHERE trailman_id = ? AND status = 'proposed'`,
  ).run(at, why, trailmanId).changes;
  return n;
}

// ------------------------------------------------------------------ run ----
/**
 * One full read sync.
 * @param {{trigger?: string, actor?: string, onlyTrailmanId?: string, client?: object}} opts
 */
async function runSync({ trigger = 'manual', actor = null, onlyTrailmanId = null, client = null } = {}) {
  const started = nowIso();
  const runId = db.prepare('INSERT INTO run (kind, started_at, trigger, actor) VALUES (?, ?, ?, ?)')
    .run('sync', started, trigger, actor).lastInsertRowid;
  const warnings = [];
  const summary = {
    trailmen: 0, read: 0, skipped: 0, incomplete: 0,
    proposed: 0, withdrawn: 0, recorded: 0, conflicts: 0, pagesRead: 0,
  };

  const finish = (ok, err) => {
    db.prepare('UPDATE run SET finished_at = ?, ok = ?, summary = ?, warnings = ? WHERE id = ?')
      .run(nowIso(), ok ? 1 : 0, JSON.stringify(err ? { ...summary, error: err } : summary),
        JSON.stringify(warnings.slice(0, 400)), runId);
    return { runId, ok, summary, warnings, error: err || null };
  };

  if (!env.TLC_ENABLED) return finish(true, 'Trail Life Connect sync is disabled (TLC_ENABLED=false).');

  const tlc = client || makeTlc();
  try {
    await tlc.login();
  } catch (e) {
    // A code prompt is not a failure of the run — it is a job for a human.
    const msg = e && e.code === tlcLib.EXIT.CODE_REQUIRED
      ? e.message
      : `Could not sign in to Trail Life Connect: ${e.message}`;
    warnings.push(msg);
    return finish(false, msg);
  }

  let roster;
  try {
    roster = await tlc.fetchTrailmen();
  } catch (e) {
    warnings.push(e.message);
    return finish(false, `Could not read the trailman list: ${e.message}`);
  }
  warnings.push(...roster.warnings);
  if (!roster.trailmen.length) return finish(false, 'Trail Life Connect returned no trailmen.');

  let people = upsertTrailmen(roster.trailmen);
  summary.trailmen = people.length;
  if (onlyTrailmanId) people = people.filter((p) => p.tlc_user_id === onlyTrailmanId);

  const autoPropose = getSetting('auto_propose');

  for (const person of people) {
    let data;
    try {
      data = await tlc.fetchTrailmanService(person.tlc_user_id);
    } catch (e) {
      summary.skipped += 1;
      warnings.push(`${person.name}: ${e.message}`);
      continue;
    }
    summary.read += 1;
    summary.pagesRead += data.pagesRead || 1;
    for (const w of data.warnings) warnings.push(`${person.name}: ${w}`);

    mirrorTrailman(person.id, data);

    // The portal prints its own hour total — an independent check on our parse.
    const check = ledgerChecksum(data.ledger);
    if (check && !check.ok) {
      warnings.push(`${person.name}: ledger total disagrees — portal says `
        + `${formatHundredths(check.declared)} h, we summed ${formatHundredths(check.summed)} h`);
    }

    const sums = sumApprovedByLevel(data.ledger.rows);
    if (!data.ledger.complete || sums.skipped > 0) {
      summary.incomplete += 1;
      const why = !data.ledger.complete
        ? `only ${data.ledger.rows.length} of ${data.ledger.declaredRows} service records could be read`
        : `${sums.skipped} service row(s) had unreadable hours`;
      warnings.push(`${person.name}: NOT proposing — ${why}`);
      holdProposals(person.id, why);
      continue;
    }

    let baseline = loadBaseline(person.id);
    const freshFrom = {};
    for (const level of STAR_LEVELS) {
      const b = baseline && baseline[level];
      if (b && b.legacyMode === 'fresh' && b.freshFrom) freshFrom[level] = b.freshFrom;
    }
    const withFresh = sumApprovedByLevel(data.ledger.rows, { freshFrom });
    const onRecord = countStarsOnRecord(data.awards.rows);
    let chain = computeStarChain({
      hoursByLevel: withFresh.hours,
      freshHoursByLevel: withFresh.freshHours,
      onRecord,
      baseline,
      woodlandsHundredths: withFresh.woodlands,
    });

    if (!baseline) {
      baseline = captureBaseline(person.id, chain);
      // Recompute against the snapshot we just took, so the first run and
      // every run after it agree.
      chain = computeStarChain({
        hoursByLevel: withFresh.hours,
        freshHoursByLevel: withFresh.freshHours,
        onRecord,
        baseline,
        woodlandsHundredths: withFresh.woodlands,
      });
    }

    summary.conflicts += chain.conflicts;
    for (const lvl of chain.levels) {
      if (lvl.conflict) {
        warnings.push(`${person.name} (${lvl.level}): ${lvl.conflict.kind === 'instance_removed'
          ? `a star instance disappeared — ${lvl.conflict.onRecord} on record, ${lvl.conflict.baselineOnRecord} at baseline`
          : `${lvl.conflict.onRecord} stars on record but the hours explain ${lvl.conflict.expected}`}`);
      }
    }

    if (autoPropose) {
      const changes = reconcileProposals(person.id, chain, data.ledger.rows);
      summary.proposed += changes.proposed;
      summary.withdrawn += changes.withdrawn;
      summary.recorded += changes.recorded;
    }
  }

  audit(actor, 'sync.run', 'run', runId, null, summary);
  return finish(true, null);
}

// -------------------------------------------------------------- read API ---
/** The computed picture for one trailman, straight from the mirror. */
function progressFor(trailmanRow) {
  const rows = db.prepare('SELECT * FROM service_row WHERE trailman_id = ? ORDER BY date').all(trailmanRow.id)
    .map((r) => ({ ...r, verified: r.verified === 1 ? true : (r.verified === 0 ? false : null) }));
  const stars = db.prepare('SELECT * FROM star_instance WHERE trailman_id = ?').all(trailmanRow.id);
  const baseline = loadBaseline(trailmanRow.id);
  const freshFrom = {};
  for (const level of STAR_LEVELS) {
    const b = baseline && baseline[level];
    if (b && b.legacyMode === 'fresh' && b.freshFrom) freshFrom[level] = b.freshFrom;
  }
  const sums = sumApprovedByLevel(rows, { freshFrom });
  const onRecord = Object.fromEntries(STAR_LEVELS.map((l) => [l, stars.filter((s) => s.level === l).length]));
  const chain = computeStarChain({
    hoursByLevel: sums.hours,
    freshHoursByLevel: sums.freshHours,
    onRecord,
    baseline,
    woodlandsHundredths: sums.woodlands,
  });
  const proposals = db.prepare(
    "SELECT * FROM proposal WHERE trailman_id = ? AND status IN ('proposed','approved') ORDER BY level, ordinal",
  ).all(trailmanRow.id);
  return {
    trailman: {
      id: trailmanRow.id, name: trailmanRow.name, tlcUserId: trailmanRow.tlc_user_id, active: !!trailmanRow.active,
    },
    rates: RATE_HUNDREDTHS,
    sums: {
      ...sums,
      display: {
        Navigator: formatHundredths(sums.hours.Navigator),
        Adventurer: formatHundredths(sums.hours.Adventurer),
        woodlands: formatHundredths(sums.woodlands),
      },
    },
    chain,
    baseline,
    stars,
    proposals,
    serviceRows: rows,
  };
}

module.exports = {
  makeTlc, runSync, progressFor,
  upsertTrailmen, mirrorTrailman, loadBaseline, captureBaseline, reconcileProposals, holdProposals,
};

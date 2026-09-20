'use strict';
/**
 * service.js — READ parsers for the Trail Life Connect pages that feed
 * Service Stars. Nothing here fetches; it turns HTML into data.
 *
 *   parseProfileService(html)   GET /profile/<trailmanHashid>?tab=service
 *                               (or ?tab=advancement — same grids) → the
 *                               precise service ledger plus the awards grid.
 *                               This is the ONLY hours source.
 *   parseTrailmenIndex(html)    GET /advancement/index → the roster of
 *                               trailmen (hashid + name) from #trailmen-select.
 *
 * WHY ONE SOURCE. The ledger grid ("Act of Service" / "Time Spent") is the
 * UNION of event-derived rows and hand-entered service records — the same
 * record ids appear in the activities grid's "Servant Service Hours" column.
 * Summing both double-counts, so the activities grid is never read for hours.
 *
 * THE 100-ROW CAP. The ledger renders at most 100 rows and NO pager, but its
 * footer row states the true count ("Total Servant Service Records: N").
 * `declaredRows` carries that number and `complete` is false whenever fewer
 * rows were parsed — the caller must fetch ?page=2, 3 … and merge (see
 * lib/tlc.js fetchLedger). A partial ledger silently undercounts hours and
 * suppresses stars, so `complete === false` must never be treated as data.
 *
 * Hours are fractional (0.25, 1.5, 14.2 all live) and are returned as INTEGER
 * HUNDREDTHS — float summing mis-totals this exact dataset.
 *
 * Output contains trailman hashids and record ids: database only, never logs.
 */
const { parseTables, findTable, tableById } = require('./grid');
const { parseTlcDate, attrOf, decodeHtml } = require('./html');
const { normalizeLevel, starLevelOfTitle, starLevelOfGroup } = require('./program');

/** The ledger footer, e.g. "Total Servant Service Records: 172". */
const TOTAL_ROW_RE = /Total\s+Servant\s+Service\s+Records:\s*([\d,]+)/i;
/**
 * The verified toggle. A GET here WRITES — read as data, never follow.
 * The id is taken up to the query string: live ids are alphanumeric, but
 * stopping at the first non-alphanumeric character would silently truncate
 * anything else and make two different records look like one.
 */
const TOGGLE_RE = /toggleServiceActive\/([^/?#"'\s]+)/i;

/** "1.75" -> 175, "14.2" -> 1420, "30" -> 3000, "" / "(not set)" / "-" -> null. */
function hoursToHundredths(text) {
  const t = String(text === null || text === undefined ? '' : text).replace(/,/g, '').trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const frac = (m[3] || '').padEnd(2, '0');
  let cents = Number(frac.slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1; // 0.333 -> 0.33, 0.335 -> 0.34
  const v = Number(m[2]) * 100 + cents;
  return m[1] ? -v : v;
}

/** 175 -> "1.75" (display only). */
function formatHundredths(n) {
  if (n === null || n === undefined) return '';
  const neg = n < 0;
  const a = Math.abs(Math.trunc(n));
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/**
 * Verified cell -> true / false / null (unknown). Reads the toggle icon class
 * or title. The href inside is the write endpoint — data only.
 */
function parseVerifiedCell(cell) {
  if (!cell) return null;
  const html = cell.html || '';
  if (/toggle-green/.test(html) || /title=["']Verified["']/i.test(html) || /glyphicon-ok\b/.test(html)) return true;
  if (/toggle-red/.test(html) || /title=["']Not Verified["']/i.test(html) || /glyphicon-remove\b/.test(html)) return false;
  const t = (cell.text || '').trim().toLowerCase();
  if (t === 'y' || t === 'yes' || t === 'verified') return true;
  if (t === 'n' || t === 'no' || t === 'not verified') return false;
  return null;
}

/** Awards-grid Progress cell -> { done, total, pct } or null. "100%" -> pct only. */
function parseProgress(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m;
  if ((m = /^(\d{1,3})\s*%$/.exec(t))) return { done: null, total: null, pct: Number(m[1]) };
  if ((m = /^(\d+)\s*\/\s*(\d+)\s+(\d{1,3})\s*%$/.exec(t))) return { done: Number(m[1]), total: Number(m[2]), pct: Number(m[3]) };
  if ((m = /^(\d+)\s*\/\s*(\d+)$/.exec(t))) return { done: Number(m[1]), total: Number(m[2]), pct: null };
  return null;
}

const LEDGER_LABELS = ['Act of Service', 'Time Spent', 'Verified'];
const AWARD_LABELS = ['Awards Title', 'Progress', 'Completed On'];

/**
 * GET /profile/<trailmanHashid>?tab=service -> the trailman's whole picture.
 * @returns {{
 *   trailmanId: string|null,
 *   ledger: { rows, declaredRows, declaredHundredths, complete },
 *   awards: { rows },
 *   stars: { Navigator: number, Adventurer: number },
 *   warnings: string[]
 * }}
 */
function parseProfileService(html) {
  const warnings = [];
  const tables = parseTables(html);
  const idm = /\/profile\/(u[a-z0-9]{11})\b|[?&]id=(u[a-z0-9]{11})\b/.exec(html || '');
  const trailmanId = idm ? (idm[1] || idm[2]) : null;

  // --- service ledger ------------------------------------------------------
  const ledger = { rows: [], declaredRows: null, declaredHundredths: null, complete: false };
  const lt = tableById(tables, 'w10') || findTable(tables, LEDGER_LABELS);
  if (!lt) {
    warnings.push('service ledger grid not found');
  } else {
    // The footer can arrive as tr.kv-page-summary (captured by the grid
    // parser) or as an ordinary row — check both, and never count it.
    const footerRow = lt.rows.find((r) => TOTAL_ROW_RE.test(r.cells[0] ? r.cells[0].text : ''));
    const footerCells = lt.summaryRow || (footerRow ? footerRow.cells : null);
    if (footerCells) {
      const tm = TOTAL_ROW_RE.exec(footerCells.map((c) => c.text).join(' '));
      if (tm) ledger.declaredRows = Number(tm[1].replace(/,/g, ''));
      for (const c of footerCells) {
        const h = hoursToHundredths(c.text);
        if (h !== null) { ledger.declaredHundredths = h; break; }
      }
    }
    for (const r of lt.rows) {
      if (TOTAL_ROW_RE.test(r.cells[0] ? r.cells[0].text : '')) continue; // the footer
      const dateText = (r.byKey.activitydate || r.byKey.servicedate || r.byKey.date || {}).text || '';
      const hoursText = (r.byKey.timespent || {}).text || '';
      const levelText = (r.byKey.eventlevel || r.byKey.level || {}).text || '';
      const date = parseTlcDate(dateText);
      const hundredths = hoursToHundredths(hoursText);
      const level = normalizeLevel(levelText);
      const vc = r.byKey.verified;
      const tm = vc && TOGGLE_RE.exec(vc.html || '');
      // A trailman with no service records still renders a placeholder row;
      // it has neither hours nor a level nor a date. Drop it silently.
      if (hundredths === null && !level && !date) continue;
      if (!date) warnings.push(`ledger row ${r.key || '?'}: unreadable date "${dateText}"`);
      if (hundredths === null) warnings.push(`ledger row ${r.key || '?'}: unreadable hours "${hoursText}"`);
      if (!level) warnings.push(`ledger row ${r.key || '?'}: unknown level "${levelText}"`);
      ledger.rows.push({
        recordId: tm ? tm[1] : (r.key || null),
        date,
        description: (r.byKey.actofservice || r.byKey.activity || r.byKey.description || {}).text || null,
        hundredths,
        level,
        verified: parseVerifiedCell(vc),
      });
    }
    ledger.complete = isLedgerComplete(ledger, warnings);
  }

  // --- awards grid (one row PER INSTANCE) ----------------------------------
  const awards = { rows: [] };
  const at = tableById(tables, 'advancement_grid') || findTable(tables, AWARD_LABELS);
  if (!at) {
    warnings.push('awards grid not found');
  } else {
    for (const r of at.rows) {
      const rowHtml = r.cells.map((c) => c.html).join(' ');
      // data-key is "<adId>|<trailmanHashid>"; fall back to scanning the row.
      const keyAd = /^(ad[a-z0-9]{10})\|/.exec(r.key || '');
      const adIds = [...new Set(rowHtml.match(/\bad[a-z0-9]{10}\b/g) || [])];
      const title = (r.byKey.awardstitle || {}).text || null;
      const dateCell = (r.byKey.completedon || {}).text || '';
      const pick = (label) => {
        const m = new RegExp(`${label}\\s*:?\\s*(\\d{1,2}/\\d{1,2}/\\d{2,4})`, 'i').exec(dateCell);
        return m ? parseTlcDate(m[1]) : null;
      };
      awards.rows.push({
        adId: keyAd ? keyAd[1] : (adIds[0] || null),
        program: (r.byKey.program || {}).text || null,
        title,
        starLevel: starLevelOfTitle(title),
        progress: parseProgress((r.byKey.progress || {}).text),
        completedOn: pick('Completed on') || pick('Started on'),
        awardedOn: pick('Awarded on'),
        purchased: /purchased\s*:?\s*(?:<[^>]*(?:glyphicon-ok|fa-check|toggle-green)|yes|y\b|1\b)/i
          .test((r.byKey.completedon || {}).html || ''),
      });
    }
  }

  // Stars on record, counted per level by TITLE (the grid carries no award id).
  const stars = { Navigator: 0, Adventurer: 0 };
  for (const a of awards.rows) if (a.starLevel) stars[a.starLevel] += 1;

  return { trailmanId, ledger, awards, stars, warnings };
}

/**
 * The ledger is complete when the footer's count matches what we parsed.
 * No footer at all (a short grid the portal renders without one) counts as
 * complete only when we are safely under the page cap.
 */
const PAGE_CAP = 100;
function isLedgerComplete(ledger, warnings) {
  const n = ledger.rows.length;
  if (ledger.declaredRows === null) {
    if (n >= PAGE_CAP) {
      warnings.push(`ledger: ${n} rows and no total row — at the page cap, so this read may be partial`);
      return false;
    }
    return true;
  }
  if (n === ledger.declaredRows) return true;
  if (n < ledger.declaredRows) {
    warnings.push(`ledger: ${ledger.declaredRows} records in total, this page holds ${n} — PAGE, do not trust a partial read`);
    return false;
  }
  warnings.push(`ledger: parsed ${n} rows but the total row says ${ledger.declaredRows}`);
  return false;
}

/**
 * Merge ledger pages into one ledger, de-duplicating rows that appear on more
 * than one page (a row can shift between pages if the portal re-sorts
 * mid-read).
 *
 * The key is the record id AND the row's contents, not the id alone. Keying
 * on the id by itself means that any time two rows parse to the same id — a
 * truncated id, or a parse that returns none — real hours are dropped without
 * a word. Including date, hours and description makes a collision require two
 * genuinely identical rows, and the ledger's own hour total catches even that.
 */
function mergeLedgerPages(pages) {
  const rows = [];
  const seen = new Set();
  let declaredRows = null;
  let declaredHundredths = null;
  for (const p of pages || []) {
    if (p.declaredRows !== null && p.declaredRows !== undefined) declaredRows = p.declaredRows;
    if (p.declaredHundredths !== null && p.declaredHundredths !== undefined) declaredHundredths = p.declaredHundredths;
    for (const r of p.rows) {
      const k = `${r.recordId || ''}|${r.date}|${r.hundredths}|${r.description || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(r);
    }
  }
  const complete = declaredRows === null ? true : rows.length === declaredRows;
  return { rows, declaredRows, declaredHundredths, complete };
}

/**
 * The ledger's own hour total is an independent checksum on our parse.
 * Returns null when the portal did not print one.
 */
function ledgerChecksum(ledger) {
  if (ledger.declaredHundredths === null || ledger.declaredHundredths === undefined) return null;
  const summed = ledger.rows.reduce((a, r) => a + (r.hundredths || 0), 0);
  return { summed, declared: ledger.declaredHundredths, ok: summed === ledger.declaredHundredths };
}

/**
 * GET /advancement/index -> who is currently at a star-earning level.
 *
 * The picker groups people with <optgroup>, and the label is their LEVEL
 * ASSIGNMENT — "Navigators", "Adventurers", or "Adult" for someone with no
 * level. That grouping, not age, is what decides whether a person can still
 * earn a star: a Trailman who turns 18 becomes a registered adult but keeps
 * his Adventurers level and keeps earning until the level is removed. So the
 * rule is the group, and only the two star groups are accepted.
 *
 * Reading the flat option list instead (what this did first) sweeps in the
 * portal's "Adult" group and invents trailmen who cannot earn anything.
 *
 * ACCEPT-KNOWN, NOT EXCLUDE-KNOWN: an unfamiliar group is left out rather than
 * let in, because including a non-trailman fabricates stars while excluding
 * one is merely visible. Everything left out is returned in `excluded` and
 * every group is counted in `groups`, so no exclusion is silent — if the
 * portal ever renames a group, the run says so instead of quietly emptying a
 * level.
 *
 * @returns {{ trailmen: Array<{trailmanId, name, level}>,
 *             excluded: Array<{name, group}>,
 *             groups: Object<string, number>,
 *             warnings: string[] }}
 */
function parseTrailmenIndex(html) {
  const sel = /<select\b[^>]*id=["']trailmen-select["'][^>]*>([\s\S]*?)<\/select\s*>/i.exec(html || '')
    || /<select\b[^>]*name=["']trailmen-select\[\]["'][^>]*>([\s\S]*?)<\/select\s*>/i.exec(html || '');
  if (!sel) {
    return { trailmen: [], excluded: [], groups: {}, warnings: ['trailmen-select not found on /advancement/index'] };
  }
  const trailmen = [];
  const excluded = [];
  const groups = {};
  const warnings = [];
  // Walk the markup in document order so each option is attributed to the
  // optgroup it sits inside.
  const UNGROUPED = '(ungrouped)';
  let group = UNGROUPED;
  const tok = /<optgroup\b([^>]*)>|<\/optgroup\s*>|<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi;
  let m;
  while ((m = tok.exec(sel[1]))) {
    if (m[1] !== undefined) { group = attrOf(m[1], 'label') || UNGROUPED; continue; }
    if (m[2] === undefined) { group = UNGROUPED; continue; }
    const value = attrOf(m[2], 'value');
    // The umbrella "All Navigators"/"All Adventurers" entries carry level ids,
    // not trailman hashids, and are skipped by this test.
    if (!value || !/^u[a-z0-9]{11}$/.test(value)) continue;
    const name = decodeHtml(m[3]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    groups[group] = (groups[group] || 0) + 1;
    const level = starLevelOfGroup(group);
    if (level) trailmen.push({ trailmanId: value, name, level });
    else excluded.push({ name, group });
  }
  if (!trailmen.length) {
    warnings.push(Object.keys(groups).length
      ? `trailman picker held no one at a star level — groups seen: ${JSON.stringify(groups)}`
      : 'trailmen-select held no trailman options');
  }
  for (const g of Object.keys(groups)) {
    if (!starLevelOfGroup(g) && g !== UNGROUPED) {
      warnings.push(`${groups[g]} person(s) in the portal's "${g}" group earn no stars and were left out`);
    }
  }
  return { trailmen, excluded, groups, warnings };
}

module.exports = {
  PAGE_CAP, LEDGER_LABELS, AWARD_LABELS,
  hoursToHundredths, formatHundredths, parseVerifiedCell, parseProgress,
  parseProfileService, parseTrailmenIndex, mergeLedgerPages, ledgerChecksum,
};

'use strict';
/**
 * stars.js — Service Star arithmetic. Pure functions, integer hundredths of
 * an hour throughout; nothing here touches a database or the network.
 *
 * Policy (troop ruling — see docs/service-stars.md):
 *   - rates per star: Navigator 15 h · Adventurer 20 h;
 *   - Fox / Hawk / Mountain Lion (Woodlands Trail) hours NEVER count and
 *     NEVER carry, so Navigator's carry-in is always 0;
 *   - Navigator leftover hours DO carry forward into Adventurer;
 *   - APPROVED (verified) hours only — never unverified rows. The chain is
 *     arithmetic-anchored, so proposals are stable and order-independent;
 *   - a level where the record holds MORE stars than the hours explain is a
 *     conflict for a leader, never a silent revert — except for stars
 *     captured in the per-trailman, per-level baseline at first sync.
 *
 * EXTRA STARS. Stars on record at baseline beyond what the hours earned then
 * are explained one of three ways, chosen per trailman and level:
 *   - 'woodlands' — the troop awarded stars on Mountain Lion / Hawk / Fox
 *     hours before excluding them. Those stars stand, and the Woodlands hours
 *     they needed stay counted as a FIXED credit: exactly what the covered
 *     stars needed at baseline, never more than the trailman's Woodlands
 *     total. The credit does not shrink, so every hour earned afterwards goes
 *     toward the NEXT star instead of paying back the old ones.
 *   - 'fresh' — a star was awarded early for some other reason. Every star on
 *     record at baseline stands and the level starts over at `freshFrom`:
 *     only hours dated on or after that day count, nothing carries in.
 *   - 'separate' (the default) — true paper-era stars the ledger never held.
 *     They stack on top of whatever the hours earn.
 */
const { STAR_LEVELS, RATE_HUNDREDTHS, isStarLevel, isWoodlands } = require('./program');
const { formatHundredths } = require('./service');

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/**
 * Sum APPROVED hours per star level from ledger rows
 * ({ level, hundredths, verified, date }).
 *
 * Woodlands hours are reported separately (never counted) because the
 * 'woodlands' legacy mode needs their total. Rows whose hours could not be
 * read are counted in `skipped` so a caller can refuse to trust a ledger it
 * did not read in full; unverified rows are counted in `unverified` so a
 * leader can see why a star has not appeared yet.
 *
 * @param {Array} rows
 * @param {{freshFrom?: Object<string,string>}} [opts]
 *        freshFrom[level] = 'YYYY-MM-DD'; hours before it are excluded from
 *        that level's `freshHours` total (used by legacyMode 'fresh').
 */
function sumApprovedByLevel(rows, { freshFrom = {} } = {}) {
  const hours = Object.fromEntries(STAR_LEVELS.map((l) => [l, 0]));
  const freshHours = Object.fromEntries(STAR_LEVELS.map((l) => [l, 0]));
  let skipped = 0;
  let counted = 0;
  let unverified = 0;
  let unknownLevel = 0;
  let woodlands = 0; // approved Woodlands hours — reported, never counted

  for (const r of rows || []) {
    if (!r) continue;
    if (r.verified !== true) { unverified += 1; continue; }
    if (!Number.isInteger(r.hundredths)) {
      if (isStarLevel(r.level) || isWoodlands(r.level)) skipped += 1;
      continue;
    }
    if (isWoodlands(r.level)) { woodlands += r.hundredths; continue; }
    if (!isStarLevel(r.level)) { unknownLevel += 1; continue; }
    hours[r.level] += r.hundredths;
    counted += 1;
    const from = freshFrom[r.level];
    if (from && r.date && r.date >= from) freshHours[r.level] += r.hundredths;
  }
  return { hours, freshHours, woodlands, counted, skipped, unverified, unknownLevel };
}

/**
 * Count stars already on record, per level, from parsed awards-grid rows.
 * @param {Array<{starLevel: string|null}>} awardRows
 */
function countStarsOnRecord(awardRows) {
  const out = Object.fromEntries(STAR_LEVELS.map((l) => [l, 0]));
  for (const a of awardRows || []) if (a && isStarLevel(a.starLevel)) out[a.starLevel] += 1;
  return out;
}

/**
 * The carry-forward chain.
 *
 * Per level: raw = hours + carryIn; available = raw + credit; earnable =
 * floor(available / rate); carryOut = available − earnable × rate; expected
 * on record = earnable + legacy; newStars = max(0, expected − onRecord);
 * conflict when onRecord > expected (stars the hours do not explain, beyond
 * the baseline) or onRecord < baseline.onRecord (an instance disappeared).
 *
 * @param {object} p
 * @param {Object<string,number>} p.hoursByLevel      approved hundredths per star level
 * @param {Object<string,number>} [p.freshHoursByLevel] hundredths on/after freshFrom
 * @param {Object<string,number>} [p.onRecord]        star instances per level, now
 * @param {Object<string,{onRecord:number,earnable:number,hours?:number,legacyMode?:string,freshFrom?:string}>|null} [p.baseline]
 * @param {number} [p.woodlandsHundredths]            approved Woodlands hours
 * @param {Object<string,number>} [p.rates]
 * @returns {{ levels: Array<object>, newStars: number, conflicts: number, carryOut: number }}
 */
function computeStarChain({
  hoursByLevel = {},
  freshHoursByLevel = {},
  onRecord = {},
  baseline = null,
  woodlandsHundredths = 0,
  rates = RATE_HUNDREDTHS,
} = {}) {
  const levels = [];
  let carry = 0; // Navigator's carry-in is always 0 — Woodlands never carries
  let newStars = 0;
  let conflicts = 0;
  const woodlands = Math.max(0, int(woodlandsHundredths));

  for (const level of STAR_LEVELS) {
    const rate = rates[level];
    const hours = int(hoursByLevel[level]);
    const raw = hours + carry;
    const rec = int(onRecord[level]);
    const base = baseline && baseline[level] ? baseline[level] : null;

    // Without a baseline, "now" is the baseline.
    const baseEarnable = base ? int(base.earnable) : Math.floor(raw / rate);
    const baseOnRecord = base ? int(base.onRecord) : rec;
    const baseAvailable = base && base.hours !== null && base.hours !== undefined && Number.isFinite(Number(base.hours))
      ? int(base.hours)
      : (base ? baseEarnable * rate : raw);

    const extras = Math.max(0, baseOnRecord - baseEarnable);
    const mode = base && ['woodlands', 'fresh'].includes(base.legacyMode) ? base.legacyMode : 'separate';
    const fresh = mode === 'fresh';

    // How many extra stars the Woodlands hours could account for.
    const woodlandsExplained = mode === 'woodlands' && extras && woodlands
      ? Math.min(extras, Math.max(0, Math.floor((baseAvailable + woodlands) / rate) - baseEarnable))
      : 0;
    const covered = fresh ? 0 : woodlandsExplained;

    // A FIXED credit — exactly what the covered stars needed at baseline — so
    // every later counted hour goes toward the next star rather than paying
    // the old ones back.
    const neededAtBaseline = Math.max(0, (baseEarnable + covered) * rate - baseAvailable);
    const credit = covered ? Math.min(woodlands, covered * rate, neededAtBaseline) : 0;

    const carryIn = fresh ? 0 : carry;
    const freshHours = fresh ? Math.max(0, int(freshHoursByLevel[level])) : null;
    const available = fresh ? freshHours : raw + credit;
    const earnable = Math.floor(available / rate);
    const carryOut = available - earnable * rate;

    // Stars that stand beyond what the counted hours earn: every baseline
    // star on a fresh start; otherwise the extras nothing above explains.
    const legacy = fresh ? baseOnRecord : extras - covered;
    const expected = earnable + legacy;
    const proposed = Math.max(0, expected - rec);

    let conflict = null;
    if (base && rec < int(base.onRecord)) {
      conflict = { kind: 'instance_removed', onRecord: rec, baselineOnRecord: int(base.onRecord) };
    } else if (rec > expected) {
      conflict = { kind: 'more_on_record', onRecord: rec, expected, unexplained: rec - expected };
    }
    if (conflict) conflicts += 1;
    newStars += proposed;

    levels.push({
      level,
      rate,
      hours,
      carryIn,
      credit,
      available,
      earnable,
      carryOut,
      onRecord: rec,
      legacy,
      expected,
      extraStars: extras,
      woodlandsExplained,
      unexplainedExtras: extras - woodlandsExplained,
      coveredStars: covered,
      legacyMode: mode,
      freshFrom: fresh ? (base.freshFrom || null) : null,
      freshHours,
      newStars: proposed,
      conflict,
      toNext: { hundredths: rate - carryOut, pct: Math.floor((carryOut * 100) / rate) },
      display: {
        hours: formatHundredths(hours),
        carryIn: formatHundredths(carryIn),
        carryOut: formatHundredths(carryOut),
        available: formatHundredths(available),
        credit: formatHundredths(credit),
        toNext: formatHundredths(rate - carryOut),
      },
    });
    carry = carryOut;
  }
  return { levels, newStars, conflicts, carryOut: carry };
}

/**
 * Snapshot a computed chain as a baseline ({ level: { onRecord, earnable,
 * hours } }). `hours` is the available total at snapshot time, which the
 * Woodlands credit needs in order to stay fixed.
 */
function baselineFrom(chain) {
  return Object.fromEntries(chain.levels.map((l) => [l.level, {
    onRecord: l.onRecord,
    earnable: l.earnable,
    hours: l.available,
  }]));
}

/**
 * Everything a caller needs for one trailman, from parsed ledger + awards.
 * Returns null hours-wise when the ledger is incomplete — the caller must
 * refuse to propose off a partial read (see CLAUDE.md).
 */
function computeForTrailman({ ledger, awardRows, baseline = null }) {
  const freshFrom = {};
  for (const level of STAR_LEVELS) {
    const b = baseline && baseline[level];
    if (b && b.legacyMode === 'fresh' && b.freshFrom) freshFrom[level] = b.freshFrom;
  }
  const sums = sumApprovedByLevel(ledger.rows, { freshFrom });
  const onRecord = countStarsOnRecord(awardRows);
  const chain = computeStarChain({
    hoursByLevel: sums.hours,
    freshHoursByLevel: sums.freshHours,
    onRecord,
    baseline,
    woodlandsHundredths: sums.woodlands,
  });
  return {
    sums,
    onRecord,
    chain,
    // A partial ledger undercounts hours, so its proposals are not safe to act on.
    trustworthy: ledger.complete === true && sums.skipped === 0,
  };
}

/**
 * When was each star of one level actually earned?
 *
 * Trail Life Connect wants a "Completed On" date for every star instance, and
 * the honest answer is the day the hours crossed the threshold — not the day
 * the tracker noticed. Walk that level's counted rows oldest-first, starting
 * from whatever carried in, and note the date of the row that tips each
 * multiple of the rate.
 *
 * Rows with no date sort last and can still tip a threshold; when one does,
 * the date is null and the caller falls back to today (and says so).
 *
 * @returns {Array<string|null>} index k-1 holds the date of the k-th star.
 */
function starDates(rowsForLevel, { rate, startingHundredths = 0, upTo = 0 } = {}) {
  const dated = (rowsForLevel || [])
    .filter((r) => r && r.verified === true && Number.isInteger(r.hundredths))
    .sort((a, b) => String(a.date || '9999-99-99').localeCompare(String(b.date || '9999-99-99')));
  const out = [];
  let total = int(startingHundredths);
  let next = 1;
  // Hours carried in can already cover whole stars before any row of this
  // level exists — those are dated by the first row, or left null.
  while (next <= upTo && total >= next * rate) { out.push(dated.length ? dated[0].date : null); next += 1; }
  for (const r of dated) {
    total += r.hundredths;
    while (next <= upTo && total >= next * rate) { out.push(r.date || null); next += 1; }
    if (next > upTo) break;
  }
  while (out.length < upTo) out.push(null); // not actually earned yet
  return out;
}

module.exports = {
  RATE_HUNDREDTHS, STAR_LEVELS,
  sumApprovedByLevel, countStarsOnRecord, computeStarChain, baselineFrom, computeForTrailman, starDates,
};

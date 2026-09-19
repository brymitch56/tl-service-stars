'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  sumApprovedByLevel, countStarsOnRecord, computeStarChain, baselineFrom, starDates,
} = require('../lib/stars');

/** hours → integer hundredths, for readable test data. */
const H = (h) => Math.round(h * 100);
const lvl = (chain, name) => chain.levels.find((l) => l.level === name);

test('only verified hours on a star level count', () => {
  const s = sumApprovedByLevel([
    { level: 'Navigator', hundredths: H(10), verified: true },
    { level: 'Navigator', hundredths: H(5), verified: false },   // unverified
    { level: 'Mountain Lion', hundredths: H(12), verified: true }, // Woodlands
    { level: 'Hawk', hundredths: H(2), verified: true },            // Woodlands
    { level: 'Adventurer', hundredths: H(3), verified: true },
    { level: 'Navigator', hundredths: null, verified: true },       // unreadable
    { level: null, hundredths: H(4), verified: true },              // no level
  ]);
  assert.equal(s.hours.Navigator, H(10));
  assert.equal(s.hours.Adventurer, H(3));
  assert.equal(s.woodlands, H(14), 'Woodlands hours are reported but never counted');
  assert.equal(s.unverified, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.unknownLevel, 1);
});

// These six cases were each checked against the live roster on 2026-09-19 and
// the record agreed exactly. They are the contract for the arithmetic.
test('the rates and the record agree: 60 Navigator hours are exactly 4 stars', () => {
  const c = computeStarChain({ hoursByLevel: { Navigator: H(60) }, onRecord: { Navigator: 4 } });
  assert.equal(lvl(c, 'Navigator').earnable, 4);
  assert.equal(lvl(c, 'Navigator').carryOut, 0);
  assert.equal(c.newStars, 0);
  assert.equal(c.conflicts, 0);
});

test('Navigator leftovers carry forward into Adventurer', () => {
  // 1 unused Navigator hour + 127 Adventurer hours = 128 → 6 Adventurer stars.
  const c = computeStarChain({
    hoursByLevel: { Navigator: H(1), Adventurer: H(127) },
    onRecord: { Navigator: 0, Adventurer: 6 },
  });
  assert.equal(lvl(c, 'Navigator').earnable, 0);
  assert.equal(lvl(c, 'Navigator').carryOut, H(1));
  assert.equal(lvl(c, 'Adventurer').carryIn, H(1));
  assert.equal(lvl(c, 'Adventurer').available, H(128));
  assert.equal(lvl(c, 'Adventurer').earnable, 6);
  assert.equal(c.newStars, 0);
});

test('Woodlands hours never carry into Navigator', () => {
  // Hawk 2 + Mountain Lion 12.5 excluded; Navigator 34 → 2 stars, not 3.
  const c = computeStarChain({
    hoursByLevel: { Navigator: H(34) },
    onRecord: { Navigator: 2 },
    woodlandsHundredths: H(14.5),
  });
  assert.equal(lvl(c, 'Navigator').carryIn, 0);
  assert.equal(lvl(c, 'Navigator').earnable, 2);
  assert.equal(c.newStars, 0);
});

test('stars actually owed are proposed', () => {
  // Navigator 29 → 1 star + 14 carried; Adventurer 82.5 + 14 = 96.5 → 4 stars.
  const c = computeStarChain({
    hoursByLevel: { Navigator: H(29), Adventurer: H(82.5) },
    onRecord: { Navigator: 0, Adventurer: 2 },
  });
  assert.equal(lvl(c, 'Navigator').newStars, 1);
  assert.equal(lvl(c, 'Adventurer').newStars, 2);
  assert.equal(c.newStars, 3);
});

test('at first sync, extras are absorbed into the baseline rather than fought', () => {
  const first = computeStarChain({ hoursByLevel: { Navigator: H(36.5) }, onRecord: { Navigator: 3 } });
  assert.equal(first.conflicts, 0, 'the first look sets the baseline; it never raises a conflict');
  assert.equal(lvl(first, 'Navigator').legacy, 1);
  const base = baselineFrom(first);
  assert.deepEqual(base.Navigator, { onRecord: 3, earnable: 2, hours: H(36.5) });
});

test('after the baseline, an unexplained star and a vanished star are both conflicts', () => {
  const base = baselineFrom(computeStarChain({ hoursByLevel: { Navigator: H(36.5) }, onRecord: { Navigator: 3 } }));
  const extra = computeStarChain({ hoursByLevel: { Navigator: H(36.5) }, onRecord: { Navigator: 4 }, baseline: base });
  assert.equal(lvl(extra, 'Navigator').conflict.kind, 'more_on_record');
  const gone = computeStarChain({ hoursByLevel: { Navigator: H(36.5) }, onRecord: { Navigator: 2 }, baseline: base });
  assert.equal(lvl(gone, 'Navigator').conflict.kind, 'instance_removed');
});

test("'separate' stacks a paper-era star on top of the hours", () => {
  const base = baselineFrom(computeStarChain({ hoursByLevel: { Navigator: H(36.5) }, onRecord: { Navigator: 3 } }));
  const c = computeStarChain({ hoursByLevel: { Navigator: H(45) }, onRecord: { Navigator: 3 }, baseline: base });
  assert.equal(lvl(c, 'Navigator').earnable, 3);
  assert.equal(lvl(c, 'Navigator').legacy, 1);
  assert.equal(lvl(c, 'Navigator').expected, 4);
  assert.equal(lvl(c, 'Navigator').newStars, 1);
});

test("'woodlands' credit is fixed, so later hours go to the NEXT star", () => {
  const base = baselineFrom(computeStarChain({ hoursByLevel: { Navigator: H(36.5) }, onRecord: { Navigator: 3 } }));
  base.Navigator.legacyMode = 'woodlands';
  const at36 = computeStarChain({
    hoursByLevel: { Navigator: H(36.5) }, onRecord: { Navigator: 3 }, baseline: base, woodlandsHundredths: H(16),
  });
  // The 3rd star needed 45 h and he had 36.5 — the credit is exactly 8.5.
  assert.equal(lvl(at36, 'Navigator').credit, H(8.5));
  assert.equal(lvl(at36, 'Navigator').earnable, 3);
  assert.equal(lvl(at36, 'Navigator').legacy, 0, 'the star is explained, not stacked');
  assert.equal(at36.newStars, 0);

  const at45 = computeStarChain({
    hoursByLevel: { Navigator: H(45) }, onRecord: { Navigator: 3 }, baseline: base, woodlandsHundredths: H(16),
  });
  assert.equal(lvl(at45, 'Navigator').credit, H(8.5), 'the credit must NOT shrink as hours accrue');
  assert.equal(lvl(at45, 'Navigator').available, H(53.5));
  assert.equal(at45.newStars, 0, 'the 4th star needs 60 available, not 60 counted');
});

test("'fresh' keeps the stars and restarts the level at a date", () => {
  const base = baselineFrom(computeStarChain({ hoursByLevel: { Navigator: H(36.5) }, onRecord: { Navigator: 3 } }));
  base.Navigator.legacyMode = 'fresh';
  base.Navigator.freshFrom = '2026-09-01';
  const c = computeStarChain({
    hoursByLevel: { Navigator: H(36.5) },
    freshHoursByLevel: { Navigator: H(16) },
    onRecord: { Navigator: 3 },
    baseline: base,
  });
  assert.equal(lvl(c, 'Navigator').carryIn, 0, 'nothing carries into a fresh start');
  assert.equal(lvl(c, 'Navigator').available, H(16));
  assert.equal(lvl(c, 'Navigator').earnable, 1);
  assert.equal(lvl(c, 'Navigator').legacy, 3);
  assert.equal(lvl(c, 'Navigator').newStars, 1);
});

test('freshFrom excludes hours dated before it', () => {
  const s = sumApprovedByLevel([
    { level: 'Navigator', hundredths: H(20), verified: true, date: '2026-05-01' },
    { level: 'Navigator', hundredths: H(16), verified: true, date: '2026-09-15' },
  ], { freshFrom: { Navigator: '2026-09-01' } });
  assert.equal(s.hours.Navigator, H(36));
  assert.equal(s.freshHours.Navigator, H(16));
});

test('a star is dated by the row that crossed the threshold', () => {
  const rows = [
    { date: '2024-01-10', hundredths: H(10), verified: true },
    { date: '2024-03-05', hundredths: H(6), verified: true },
    { date: '2024-06-01', hundredths: H(20), verified: true },
  ];
  assert.deepEqual(starDates(rows, { rate: 1500, upTo: 2 }), ['2024-03-05', '2024-06-01']);
  // Hours carried in can already cover a star before this level has any rows.
  assert.deepEqual(starDates(rows, { rate: 1500, startingHundredths: H(5), upTo: 1 }), ['2024-01-10']);
  // Asking for more stars than were earned yields nulls, never a wrong date.
  assert.deepEqual(starDates(rows, { rate: 1500, upTo: 4 }), ['2024-03-05', '2024-06-01', null, null]);
});

test('stars on record are counted per level', () => {
  assert.deepEqual(countStarsOnRecord([
    { starLevel: 'Navigator' }, { starLevel: 'Navigator' }, { starLevel: 'Adventurer' }, { starLevel: null },
  ]), { Navigator: 2, Adventurer: 1 });
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  parseProfileService, parseTrailmenIndex, mergeLedgerPages, ledgerChecksum,
  hoursToHundredths, formatHundredths,
} = require('../lib/service');
const F = require('./fixtures');

const row = F.ledgerRow;

test('hours parse as integer hundredths, never floats', () => {
  assert.equal(hoursToHundredths('1.5'), 150);
  assert.equal(hoursToHundredths('14.2'), 1420);
  assert.equal(hoursToHundredths('30'), 3000);
  assert.equal(hoursToHundredths('0.333'), 33);
  assert.equal(hoursToHundredths('0.335'), 34);
  assert.equal(hoursToHundredths('1,234'), 123400);
  assert.equal(hoursToHundredths('(not set)'), null);
  assert.equal(hoursToHundredths(''), null);
  assert.equal(formatHundredths(1420), '14.20');
});

test('the ledger footer is a total, not a data row', () => {
  const html = F.profilePage(F.TRAILMAN_A, {
    ledger: F.ledgerGrid([
      row({ key: 'r1', date: '12/08/2025', act: 'Meeting', hours: '1.5', level: 'Adventurer' }),
      row({ key: 'r2', date: '04/17/2025', act: 'Work camp', hours: '30', level: 'Adventurer' }),
    ], { totalHours: '31.5' }),
    awards: [],
  });
  const p = parseProfileService(html);
  assert.equal(p.ledger.rows.length, 2, 'the total row must not be counted as data');
  assert.equal(p.ledger.declaredRows, 2);
  assert.equal(p.ledger.complete, true);
  assert.deepEqual(ledgerChecksum(p.ledger), { summed: 3150, declared: 3150, ok: true });
});

test('the activities grid is never read for hours', () => {
  // The fixture's activities grid carries 999 service hours on purpose.
  const html = F.profilePage(F.TRAILMAN_A, {
    ledger: F.ledgerGrid([row({ key: 'r1', date: '12/08/2025', act: 'Meeting', hours: '1.5', level: 'Navigator' })],
      { totalHours: '1.5' }),
    awards: [],
  });
  const p = parseProfileService(html);
  assert.equal(p.ledger.rows.length, 1);
  assert.equal(p.ledger.rows[0].hundredths, 150);
});

test('the 100-row cap is detected, not silently accepted', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push(row({ key: `r${i}`, date: '01/02/2024', act: 'Service', hours: '2', level: 'Navigator' }));
  }
  const p = parseProfileService(F.profilePage(F.TRAILMAN_A, {
    ledger: F.ledgerGrid(rows, { declared: 172, totalHours: '344' }),
    awards: [],
  }));
  assert.equal(p.ledger.rows.length, 100);
  assert.equal(p.ledger.declaredRows, 172);
  assert.equal(p.ledger.complete, false, 'a partial ledger must report itself incomplete');
  assert.ok(p.warnings.some((w) => /PAGE, do not trust a partial read/.test(w)));
});

test('an empty ledger is zero rows, not one phantom row', () => {
  const p = parseProfileService(F.profilePage(F.TRAILMAN_A, { ledger: F.EMPTY_LEDGER, awards: [] }));
  assert.equal(p.ledger.rows.length, 0);
  assert.equal(p.ledger.complete, true);
  assert.equal(p.warnings.filter((w) => /ledger row/.test(w)).length, 0, 'the placeholder must not warn');
});

test('the verified toggle is read, never followed', () => {
  const p = parseProfileService(F.profilePage(F.TRAILMAN_A, {
    ledger: F.ledgerGrid([
      row({ key: 'r1', date: '12/08/2025', act: 'A', hours: '1', level: 'Navigator', verified: true }),
      row({ key: 'r2', date: '12/09/2025', act: 'B', hours: '2', level: 'Navigator', verified: false }),
    ], { totalHours: '3' }),
    awards: [],
  }));
  assert.equal(p.ledger.rows[0].verified, true);
  assert.equal(p.ledger.rows[1].verified, false);
  assert.equal(p.ledger.rows[0].recordId, 'r1', 'the record id comes out of the toggle href');
});

test('star instances are matched by title, because the grid carries no award id', () => {
  const p = parseProfileService(F.profilePage(F.TRAILMAN_A, {
    ledger: F.EMPTY_LEDGER,
    awards: [
      F.awardRow({ adId: 'adaaaaaaaaaa', trailmanId: F.TRAILMAN_A, program: 'Navigators', title: 'Navigator Service Star', completed: '04/17/2025', awarded: '05/19/2025' }),
      F.awardRow({ adId: 'adbbbbbbbbbb', trailmanId: F.TRAILMAN_A, program: 'Navigators', title: 'Navigator Service Star', completed: '11/02/2024' }),
      F.awardRow({ adId: 'adcccccccccc', trailmanId: F.TRAILMAN_A, program: 'Adventurers', title: 'Adventurer Service Star', completed: '01/05/2026' }),
      F.awardRow({ adId: 'addddddddddd', trailmanId: F.TRAILMAN_A, program: 'Navigators', title: 'Aquatics (2019)', completed: '08/03/2025' }),
    ],
  }));
  assert.equal(p.stars.Navigator, 2);
  assert.equal(p.stars.Adventurer, 1);
  const first = p.awards.rows.find((a) => a.adId === 'adaaaaaaaaaa');
  assert.equal(first.completedOn, '2025-04-17');
  assert.equal(first.awardedOn, '2025-05-19');
  assert.equal(p.awards.rows.find((a) => a.title === 'Aquatics (2019)').starLevel, null);
});

test('ledger pages merge and de-duplicate', () => {
  const page1 = { rows: [{ recordId: 'a', hundredths: 100 }, { recordId: 'b', hundredths: 200 }], declaredRows: 3, declaredHundredths: 600 };
  const page2 = { rows: [{ recordId: 'b', hundredths: 200 }, { recordId: 'c', hundredths: 300 }], declaredRows: 3, declaredHundredths: 600 };
  const merged = mergeLedgerPages([page1, page2]);
  assert.equal(merged.rows.length, 3);
  assert.equal(merged.complete, true);
  assert.deepEqual(ledgerChecksum(merged), { summed: 600, declared: 600, ok: true });
});

test('the trailman picker yields hashids, not the level groups', () => {
  const { trailmen } = parseTrailmenIndex(F.advancementIndex([
    { id: F.TRAILMAN_A, name: 'Rivers, Sam' },
    { id: F.TRAILMAN_B, name: 'Vance, Theo', group: 'Adventurers' },
  ]));
  assert.equal(trailmen.length, 2, 'the two umbrella entries are not people');
  assert.deepEqual(trailmen.map((t) => t.trailmanId).sort(), [F.TRAILMAN_A, F.TRAILMAN_B].sort());
  assert.equal(trailmen.find((t) => t.trailmanId === F.TRAILMAN_A).level, 'Navigator');
  assert.equal(trailmen.find((t) => t.trailmanId === F.TRAILMAN_B).level, 'Adventurer');
});

// --------------------------------------------------- the trailman picker ---
/**
 * The picker groups people by LEVEL ASSIGNMENT, and that is what decides who
 * can earn a star — not whether they are an adult. A Trailman who turns 18
 * becomes a registered adult but keeps his Adventurers level and keeps
 * earning until the level is removed, so he stays in the Adventurers group
 * and must stay in the app. The portal's own "Adult" group is the one that
 * earns nothing. Read live 2026-09-19.
 */
const picker = (groups, ungrouped = []) => '<select id="trailmen-select" name="trailmen-select[]" multiple>'
  + ungrouped.map((o) => `<option value="${o.v}">${o.n}</option>`).join('')
  + Object.entries(groups).map(([label, people]) => `<optgroup label="${label}">`
    + people.map((p) => `<option value="${p.v}">${p.n}</option>`).join('') + '</optgroup>').join('')
  + '</select>';

test('only people at a star level are taken from the picker', () => {
  const r = parseTrailmenIndex(picker({
    Adult: [{ v: 'u00000000001', n: 'Ashford, Nathaniel' }],
    Navigators: [{ v: 'u00000000002', n: 'Holt, Miles' }],
    Adventurers: [{ v: 'u00000000003', n: 'Vance, Theo' }],
  }, [
    // the umbrella entries carry level ids, not trailman hashids
    { v: 'j8e296a067a3', n: 'All Navigators' },
    { v: 'x1ff1de77400', n: 'All Adventurers' },
  ]));
  assert.deepEqual(r.trailmen.map((t) => [t.name, t.level]), [
    ['Holt, Miles', 'Navigator'],
    ['Vance, Theo', 'Adventurer'],
  ]);
  assert.deepEqual(r.excluded, [{ name: 'Ashford, Nathaniel', group: 'Adult' }]);
  assert.deepEqual(r.groups, { Adult: 1, Navigators: 1, Adventurers: 1 });
});

test('an adult still assigned to a star level is kept', () => {
  // The 18-year-old case: registered adult, still an Adventurer, still earning.
  const r = parseTrailmenIndex(picker({
    Adventurers: [{ v: 'u00000000004', n: 'Rivers, Sam' }],
    Adult: [{ v: 'u00000000005', n: 'Wilder, Aaron' }],
  }));
  assert.deepEqual(r.trailmen.map((t) => t.name), ['Rivers, Sam']);
  assert.equal(r.trailmen[0].level, 'Adventurer');
});

test('an exclusion is never silent', () => {
  const r = parseTrailmenIndex(picker({
    Adult: [{ v: 'u00000000006', n: 'One, Someone' }, { v: 'u00000000007', n: 'Two, Someone' }],
    Navigators: [{ v: 'u00000000008', n: 'Holt, Miles' }],
  }));
  assert.ok(r.warnings.some((w) => /"Adult" group earn no stars/.test(w)));
  assert.equal(r.excluded.length, 2);
});

test('an unfamiliar group is left out and reported, not let in', () => {
  const r = parseTrailmenIndex(picker({
    Alumni: [{ v: 'u00000000009', n: 'Past, Person' }],
    Navigators: [{ v: 'u00000000010', n: 'Holt, Miles' }],
  }));
  assert.deepEqual(r.trailmen.map((t) => t.name), ['Holt, Miles']);
  assert.ok(r.warnings.some((w) => /"Alumni"/.test(w)));
});

test('a renamed level group empties the list loudly rather than quietly', () => {
  const r = parseTrailmenIndex(picker({ Navigator: [{ v: 'u00000000011', n: 'Holt, Miles' }] }));
  assert.equal(r.trailmen.length, 0);
  assert.ok(r.warnings.some((w) => /no one at a star level/.test(w)), r.warnings.join('; '));
});

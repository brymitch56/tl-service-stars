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
      F.awardRow({ adId: 'adddddddddddd', trailmanId: F.TRAILMAN_A, program: 'Navigators', title: 'Aquatics (2019)', completed: '08/03/2025' }),
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
    { id: F.TRAILMAN_B, name: 'Vance, Theo' },
  ]));
  assert.equal(trailmen.length, 2);
  assert.deepEqual(trailmen.map((t) => t.trailmanId), [F.TRAILMAN_A, F.TRAILMAN_B]);
  assert.equal(trailmen[0].name, 'Rivers, Sam');
});

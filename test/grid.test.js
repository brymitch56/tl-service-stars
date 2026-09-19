'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTables, findTable, tableById, parseSummary } = require('../lib/grid');
const { decodeHtml, textOf, parseTlcDate, toPortalDate, inputsIn, csrfFrom } = require('../lib/html');

test('the filter row and the page-summary row are not data', () => {
  const html = '<div class="grid-view" id="w10-container"><div class="summary">Showing 1-25 of 40 items.</div>'
    + '<table><thead><tr><th>Activity Date</th><th>Time Spent</th></tr>'
    + '<tr class="filters"><td><input></td><td><input></td></tr></thead>'
    + '<tbody><tr data-key="k1"><td>12/08/2025</td><td>1.5</td></tr>'
    + '<tr class="kv-page-summary"><td>Total Servant Service Records: 9</td><td>65.5</td></tr></tbody></table></div>';
  const t = parseTables(html)[0];
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].key, 'k1');
  assert.equal(t.rows[0].byKey.timespent.text, '1.5');
  assert.deepEqual(t.summaryRow.map((c) => c.text), ['Total Servant Service Records: 9', '65.5']);
  assert.deepEqual(t.summary, { from: 1, to: 25, total: 40 });
  assert.equal(t.id, 'w10-container');
});

test('grids are found by id or by their column labels', () => {
  const t = parseTables('<div class="grid-view" id="w10-container"><table><thead><tr>'
    + '<th>Act of Service</th><th>Time Spent</th><th>Verified</th></tr></thead><tbody></tbody></table></div>');
  assert.ok(tableById(t, 'w10'));
  assert.ok(findTable(t, ['Time Spent', 'Verified']));
  assert.equal(findTable(t, ['Nope']), null);
});

test('cells expose hrefs as data (they are never fetched)', () => {
  const t = parseTables('<table><thead><tr><th>Verified</th></tr></thead><tbody><tr data-key="k">'
    + '<td><a href="/fields/toggleServiceActive/k?attribute=verified">x</a></td></tr></tbody></table>')[0];
  assert.deepEqual(t.rows[0].cells[0].hrefs, ['/fields/toggleServiceActive/k?attribute=verified']);
});

test('colspan keeps later cells aligned to their headers', () => {
  const t = parseTables('<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>'
    + '<tbody><tr><td colspan="2">wide</td><td>third</td></tr></tbody></table>')[0];
  assert.equal(t.rows[0].byKey.a.text, 'wide');
  assert.equal(t.rows[0].byKey.c.text, 'third');
});

test('pager summaries in both spellings', () => {
  assert.deepEqual(parseSummary('Showing 1-25 of 5,499 items.'), { from: 1, to: 25, total: 5499 });
  assert.deepEqual(parseSummary('Total 671 items.'), { total: 671 });
  assert.equal(parseSummary('nothing here'), null);
});

test('html helpers', () => {
  assert.equal(decodeHtml('a &amp; b &quot;c&quot; &nbsp;d'), 'a & b "c"  d');
  assert.equal(textOf('<b>a</b><script>evil()</script> b'), 'a b');
  assert.equal(parseTlcDate('12/8/25'), '2025-12-08');
  assert.equal(parseTlcDate('1/1/70'), null, 'the epoch-0 artefact is not a date');
  assert.equal(parseTlcDate('not a date'), null);
  assert.equal(toPortalDate('2026-04-17'), '04/17/2026');
  assert.equal(csrfFrom('<meta name="csrf-token" content="tok">'), 'tok');
  assert.equal(csrfFrom('<input name="_csrf" value="tok2">'), 'tok2');
});

test('an input NAMED "...-checked" is not a checked input', () => {
  const ins = inputsIn('<input type="checkbox" name="lock-checked" value="1">'
    + '<input type="checkbox" name="show-items-checked" value="1" checked>');
  assert.equal(ins[0].checked, false, 'the name must not be mistaken for the attribute');
  assert.equal(ins[1].checked, true);
});

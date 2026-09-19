'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  serializeForm, parseStandardFragment, firstEmptySlot, filledCount,
  savedSignature, panelPairs, buildSaveBody,
} = require('../lib/standard');
const F = require('./fixtures');

const namesOf = (pairs) => pairs.map(([n]) => n);
const get = (pairs, name) => { const p = pairs.find(([n]) => n === name); return p ? p[1] : undefined; };

/**
 * Everything asserted here was read off the live portal on 2026-09-19, for a
 * trailman already holding two Navigator Service Stars.
 */

// ------------------------------------------------------------ serializing --
test('serializeForm submits what a browser would, and nothing else', () => {
  const pairs = serializeForm(F.advancementPage());
  const names = namesOf(pairs);

  assert.equal(get(pairs, 'style-select'), 'standard', 'only the checked radio');
  assert.equal(names.filter((n) => n === 'style-select').length, 1, 'not all three radios');
  assert.equal(get(pairs, 'level-select'), 'navadv');
  assert.ok(!names.includes('submit-progress'), 'a submit button is not a field');

  // Krajee checkbox-x controls are TEXT inputs carrying "0"/"1" — always sent.
  assert.equal(get(pairs, 'lock-checked'), '1');
  assert.equal(get(pairs, 'show-items-checked'), '0');
  assert.equal(get(pairs, 'track-attendance'), '0');
  // A readonly datepicker IS submitted; a textarea contributes its content.
  assert.equal(get(pairs, 'date-specified'), '09/19/2026');
  assert.equal(get(pairs, 'comment-specified'), '');
});

test('serializeForm skips disabled controls and unchecked boxes', () => {
  const pairs = serializeForm(
    '<input type="text" name="kept" value="1">'
    + '<input type="text" name="skipped" value="x" disabled>'
    + '<input type="checkbox" name="off" value="1">'
    + '<input type="checkbox" name="on" value="1" checked>'
    + '<input type="file" name="upload">',
  );
  assert.deepEqual(namesOf(pairs), ['kept', 'on']);
});

// ------------------------------------------------------------------ slots --
test('an existing instance has no new- input; an empty slot does', () => {
  const p = parseStandardFragment(F.standardFragment({
    filled: [
      { adId: 'adexisting01', completed: '05/02/2026', awarded: '05/18/2026', purchased: '1' },
      { adId: 'adexisting02', completed: '03/15/2026', awarded: '05/18/2026', purchased: '1' },
    ],
    empty: 6,
  }));
  assert.equal(p.slots.length, 8);
  assert.equal(filledCount(p), 2);

  const existing = p.slots.find((s) => s.adId === 'adexisting01');
  assert.equal(existing.hasNewField, false, 'the portal sends no new- input for an existing instance');
  assert.equal(existing.purchased, '1', 'purchased is a text widget carrying "1", not a checkbox');

  const empty = firstEmptySlot(p);
  assert.ok(empty);
  assert.equal(empty.hasNewField, true);
  assert.equal(empty.isNew, true);
});

test('the fragment is panels only — no form, no csrf, no page controls', () => {
  const pairs = serializeForm(F.standardFragment({ filled: [], empty: 2 }));
  const nonSlot = pairs.filter(([n]) => !/^(new|completed_on|awarded_on|purchased|comment)-ad/.test(n));
  assert.deepEqual(nonSlot, [], 'a fragment carries nothing but award panels');
});

test('page-level controls are never mistaken for award slots', () => {
  // `comment-specified` and `date-specified` share the slot prefixes.
  const p = parseStandardFragment(F.advancementPage());
  assert.equal(p.slots.length, 0, 'the page form has no award slots of its own');
});

test('slot ids are minted fresh on every fetch, so a fragment is never reused', () => {
  const a = parseStandardFragment(F.standardFragment({ empty: 1 }));
  const b = parseStandardFragment(F.standardFragment({ empty: 1 }));
  assert.notEqual(firstEmptySlot(a).adId, firstEmptySlot(b).adId);
});

test('a fragment with no slots at all is reported, not guessed at', () => {
  const p = parseStandardFragment('<div>nothing here</div>');
  assert.equal(p.slots.length, 0);
  assert.equal(firstEmptySlot(p), null);
  assert.ok(p.warnings.length);
});

// ------------------------------------------------------------- the body ----
test('the save body is the page form PLUS the panels, with one slot filled', () => {
  const fragment = F.standardFragment({
    filled: [{ adId: 'adexisting01', completed: '05/02/2026', awarded: '05/18/2026', purchased: '1', comment: 'kept' }],
    empty: 2,
  });
  const parsed = parseStandardFragment(fragment);
  const slot = firstEmptySlot(parsed);
  const body = buildSaveBody({
    pageHtml: F.advancementPage(),
    fragmentHtml: fragment,
    slotId: slot.adId,
    trailmanId: F.TRAILMAN_A,
    awardId: 'acc66f374e08',
    levelSelect: 'navadv',
    completedOn: '09/19/2026',
    comment: 'recorded by the tracker',
    purchased: '0',
  });

  // every page field the portal always sends
  for (const n of ['_csrf', 'style-select', 'date-specified', 'lock-checked',
    'show-completed-checked', 'show-items-checked', 'comment-specified',
    'event-attendance', 'track-attendance']) {
    assert.ok(namesOf(body).includes(n), `the body must carry ${n}`);
  }
  // the ones we set ourselves, exactly once each
  assert.equal(namesOf(body).filter((n) => n === 'level-select').length, 1);
  assert.equal(get(body, 'level-select'), 'navadv');
  assert.equal(get(body, 'trailmen-select[]'), F.TRAILMAN_A);
  assert.equal(get(body, 'badge-select'), 'acc66f374e08');

  // the existing instance, byte for byte, with no invented new- field
  assert.equal(get(body, 'completed_on-adexisting01'), '05/02/2026');
  assert.equal(get(body, 'awarded_on-adexisting01'), '05/18/2026');
  assert.equal(get(body, 'purchased-adexisting01'), '1');
  assert.equal(get(body, 'comment-adexisting01'), 'kept');
  assert.equal(get(body, 'new-adexisting01'), undefined);

  // the one slot we filled
  assert.equal(get(body, `new-${slot.adId}`), 'true');
  assert.equal(get(body, `completed_on-${slot.adId}`), '09/19/2026');
  assert.equal(get(body, `comment-${slot.adId}`), 'recorded by the tracker');

  // the other empty slot stays empty
  const other = parsed.slots.find((s) => s.isNew && s.adId !== slot.adId);
  assert.equal(get(body, `completed_on-${other.adId}`), '');
});

test('the body carries no duplicate of a field we override', () => {
  const fragment = F.standardFragment({ empty: 1 });
  const slot = firstEmptySlot(parseStandardFragment(fragment));
  const body = buildSaveBody({
    pageHtml: F.advancementPage(),
    fragmentHtml: fragment,
    slotId: slot.adId,
    trailmanId: F.TRAILMAN_A,
    awardId: 'acc66f374e08',
    levelSelect: 'navadv',
    completedOn: '09/19/2026',
    comment: '',
  });
  for (const n of ['level-select', 'trailmen-select[]', 'badge-select']) {
    assert.equal(namesOf(body).filter((x) => x === n).length, 1, `${n} must appear once`);
  }
});

test('panelPairs never drops a panel field', () => {
  const fragment = F.standardFragment({
    filled: [{ adId: 'adexisting01', completed: '05/02/2026' }], empty: 3,
  });
  const parsed = parseStandardFragment(fragment);
  const slot = firstEmptySlot(parsed);
  const pairs = panelPairs(fragment, { slotId: slot.adId, completedOn: '09/19/2026', comment: 'x' });
  // 1 existing x 4 fields + 3 empty x 5 fields = 19
  assert.equal(pairs.length, 19);
});

// -------------------------------------------------------------- read-back --
test('savedSignature ignores empty slots and notices a change', () => {
  const a = parseStandardFragment(F.standardFragment({
    filled: [{ adId: 'adexisting01', completed: '05/02/2026', purchased: '1' }], empty: 2,
  }));
  const b = parseStandardFragment(F.standardFragment({
    filled: [{ adId: 'adexisting01', completed: '05/02/2026', purchased: '1' }], empty: 2,
  }));
  assert.deepEqual(savedSignature(a), savedSignature(b), 'the empty slots differ but are not signed');

  const changed = parseStandardFragment(F.standardFragment({
    filled: [{ adId: 'adexisting01', completed: '01/01/2020', purchased: '1' }], empty: 2,
  }));
  assert.notDeepEqual(savedSignature(a), savedSignature(changed),
    'a pre-existing instance changing must be visible');
});

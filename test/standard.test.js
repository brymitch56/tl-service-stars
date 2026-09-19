'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseStandardFragment, firstEmptySlot, filledCount, toFields } = require('../lib/standard');
const F = require('./fixtures');

/**
 * The shape asserted here was read off the live advancement form on
 * 2026-09-19 for a trailman who already held two Navigator Service Stars:
 * two instances with dates and purchased="1" and NO `new-` input, then six
 * empty slots each carrying `new-<adId>` = "true", alongside the page-level
 * `date-specified` / `comment-specified` controls.
 */
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
  assert.equal(existing.isNew, false);
  assert.equal(existing.purchased, '1', 'purchased is a text widget carrying "1", not a checkbox');

  const empty = firstEmptySlot(p);
  assert.ok(empty);
  assert.equal(empty.hasNewField, true);
  assert.equal(empty.isNew, true);
});

test('page-level controls are not award slots', () => {
  const p = parseStandardFragment(F.standardFragment({ filled: [], empty: 1 }));
  assert.ok(!p.slots.some((s) => s.adId === 'specified'),
    'comment-specified must not become a phantom slot');
  assert.equal(p.others['comment-specified'], '', 'it is echoed as an ordinary field');
  assert.equal(p.others['date-specified'], '');
});

test('the echo repeats every field and changes exactly one slot', () => {
  const p = parseStandardFragment(F.standardFragment({
    filled: [{ adId: 'adexisting01', completed: '05/02/2026', awarded: '05/18/2026', purchased: '1', comment: 'kept' }],
    empty: 2,
  }));
  const target = firstEmptySlot(p);
  const out = toFields(p, {
    adId: target.adId, completedOn: '09/19/2026', comment: 'added', purchased: '0',
  }, { _csrf: 'fresh' });

  // the existing instance, byte for byte
  assert.equal(out['completed_on-adexisting01'], '05/02/2026');
  assert.equal(out['awarded_on-adexisting01'], '05/18/2026');
  assert.equal(out['purchased-adexisting01'], '1');
  assert.equal(out['comment-adexisting01'], 'kept');
  assert.equal('new-adexisting01' in out, false);

  // the one slot we filled
  assert.equal(out[`completed_on-${target.adId}`], '09/19/2026');
  assert.equal(out[`comment-${target.adId}`], 'added');
  assert.equal(out[`new-${target.adId}`], 'true');

  // the other empty slot stays empty, and page fields survive
  const other = p.slots.find((s) => s.isNew && s.adId !== target.adId);
  assert.equal(out[`completed_on-${other.adId}`], '');
  assert.equal(out._csrf, 'fresh');
  assert.equal(out['comment-specified'], '');
  assert.equal(out['show-items-checked'], '1');
  assert.equal('lock-checked' in out, false);
});

test('slot ids are minted fresh on every fetch, so a fragment is never reused', () => {
  const a = parseStandardFragment(F.standardFragment({ empty: 1 }));
  const b = parseStandardFragment(F.standardFragment({ empty: 1 }));
  assert.notEqual(firstEmptySlot(a).adId, firstEmptySlot(b).adId);
});

test('a fragment with no slots at all is reported, not guessed at', () => {
  const p = parseStandardFragment('<form><input type="hidden" name="_csrf" value="x"></form>');
  assert.equal(p.slots.length, 0);
  assert.equal(firstEmptySlot(p), null);
  assert.ok(p.warnings.length);
});

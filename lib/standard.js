'use strict';
/**
 * standard.js — the advancement form: reading its award slots, and building
 * the body that adds one instance without disturbing anything else.
 *
 * WHAT THE PORTAL ACTUALLY DOES (read live, 2026-09-19; every detail here
 * cost a round trip, so none of it is guesswork):
 *
 * 1. `POST /advancement/badge-tracker-view` returns ONLY the award panels —
 *    no <form>, no _csrf, no page-level fields, ~54 KB of markup for one
 *    trailman. Its parameters are NOT the form's field names:
 *        _csrf, level, style, trailmen[], badges, lockedChecked,
 *        event_id, track_attendance
 *
 * 2. `POST /advancement/index` — the save — takes the PAGE form's own names:
 *        _csrf, style-select, level-select, trailmen-select[], badge-select,
 *        date-specified, lock-checked, show-completed-checked,
 *        show-items-checked, comment-specified, track-attendance,
 *        event-attendance     …plus every award panel field.
 *
 *    So the body is the page form PLUS the fragment's panels. Building it
 *    from the fragment alone leaves out nine fields the form always sends.
 *
 * 3. Each panel is keyed by an advancement record id:
 *        new-<adId>            only on an EMPTY slot ("true"); an instance
 *                              already on the record has no such input
 *        completed_on-<adId>   MM/DD/YYYY, a readonly datepicker input
 *        awarded_on-<adId>     MM/DD/YYYY
 *        purchased-<adId>      a Krajee checkbox-x TEXT input: "0" or "1"
 *        comment-<adId>        textarea
 *
 * 4. `level-select` and `style-select` are RADIOS, not selects, and their
 *    values are short codes — `wt` | `navadv`, and `standard` | `grid` |
 *    `summary` — not the level hashids used elsewhere on the site.
 *
 * 5. `lock-checked`, `show-*-checked` and `track-attendance` are Krajee
 *    checkbox-x TEXT inputs carrying "0"/"1", so they are always submitted.
 *
 * SLOT IDS ARE NOT RESERVATIONS: every fetch of the fragment mints fresh
 * `new-` ids. The push therefore fetches the fragment immediately before each
 * save and never reuses one.
 *
 * ECHO EVERYTHING. The save replaces the whole form, so a field left out is a
 * field cleared — on records we never meant to touch.
 */
const { decodeHtml, attrsOf } = require('./html');

/** A panel field: one of five prefixes, then an advancement record id. */
const SLOT_RE = /^(new|completed_on|awarded_on|purchased|comment)-(ad[a-z0-9]{10})$/i;

/**
 * Fields a browser would NOT submit, by input type.
 * (`readonly` IS submitted — the datepickers are readonly. `disabled` is not.)
 */
const NEVER_SUBMITTED = new Set(['submit', 'button', 'file', 'image', 'reset']);

/**
 * Browser-faithful serialisation of every successful-submit control in an
 * HTML string, in document order.
 *
 * This is the behaviour a real form POST produces: skip disabled controls and
 * buttons; an unchecked checkbox or radio contributes nothing; a select
 * contributes its selected options (or its first option when the markup marks
 * none, which is what a browser shows and therefore submits).
 *
 * @returns {Array<[string, string]>}
 */
function serializeForm(html) {
  const pairs = [];
  const re = /<(input|textarea|select)\b([^>]*?)(\/?)>(?:([\s\S]*?)<\/\1\s*>)?/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const tag = m[1].toLowerCase();
    const a = attrsOf(m[2]);
    const name = (a.name || '').trim();
    if (!name || 'disabled' in a) continue;

    if (tag === 'input') {
      const type = (a.type || 'text').toLowerCase();
      if (NEVER_SUBMITTED.has(type)) continue;
      if ((type === 'checkbox' || type === 'radio') && !('checked' in a)) continue;
      pairs.push([name, a.value === undefined ? (type === 'checkbox' ? 'on' : '') : a.value]);
    } else if (tag === 'textarea') {
      pairs.push([name, decodeHtml(m[4] || '')]);
    } else {
      const opts = [...(m[4] || '').matchAll(/<option\b([^>]*)>/gi)].map((o) => attrsOf(o[1]));
      const selected = opts.filter((o) => 'selected' in o);
      const multiple = 'multiple' in a;
      const chosen = selected.length ? selected : (multiple || !opts.length ? [] : [opts[0]]);
      for (const o of chosen) pairs.push([name, o.value || '']);
    }
  }
  return pairs;
}

/**
 * The award slots in a Standard-view fragment.
 * @returns {{ slots: Array<{adId, isNew, hasNewField, completedOn, awardedOn, purchased, comment}>,
 *             warnings: string[] }}
 */
function parseStandardFragment(html) {
  const byId = new Map();
  const slotOf = (adId) => {
    if (!byId.has(adId)) {
      // `hasNewField` records whether the portal sent a `new-` input at all.
      // An instance already on the record has none — it is NOT sent as
      // "false" — so echoing one back would invent a field.
      byId.set(adId, {
        adId, isNew: false, hasNewField: false, completedOn: '', awardedOn: '', purchased: '', comment: '',
      });
    }
    return byId.get(adId);
  };

  for (const [name, value] of serializeForm(html)) {
    const m = SLOT_RE.exec(name);
    // Page-level controls (`comment-specified`, `date-specified`) share the
    // prefixes but are not slots — the id pattern is what tells them apart.
    if (!m) continue;
    const s = slotOf(m[2]);
    switch (m[1].toLowerCase()) {
      case 'new': s.hasNewField = true; s.isNew = /^(true|1)$/i.test(value); break;
      case 'completed_on': s.completedOn = value; break;
      case 'awarded_on': s.awardedOn = value; break;
      case 'purchased': s.purchased = value; break;
      default: s.comment = value; break;
    }
  }
  const slots = [...byId.values()];
  return { slots, warnings: slots.length ? [] : ['no award slots found in the Standard-view fragment'] };
}

/** An empty `new-` slot the push may fill, or null when the portal offered none. */
function firstEmptySlot(parsed) {
  return parsed.slots.find((s) => s.isNew && !s.completedOn && !s.awardedOn && !String(s.comment || '').trim()) || null;
}

/** How many slots already hold a recorded instance (a completed-on date). */
function filledCount(parsed) {
  return parsed.slots.filter((s) => s.completedOn).length;
}

/**
 * A stable signature of the instances already on the record, so "nothing else
 * changed" can be asserted byte for byte after the save.
 */
function savedSignature(parsed, exceptAdId = null) {
  return parsed.slots
    .filter((s) => !s.isNew && s.adId !== exceptAdId)
    .map((s) => [s.adId, s.completedOn, s.awardedOn, s.purchased, s.comment])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * The fragment's panel fields, in document order, with ONE empty slot filled.
 * Everything else — every field of every existing instance — is repeated
 * exactly as it came.
 */
function panelPairs(fragmentHtml, { slotId, completedOn, comment = '', purchased }) {
  const pairs = serializeForm(fragmentHtml).filter(([n]) => SLOT_RE.test(n));
  const set = (prefix, value) => {
    const name = `${prefix}-${slotId}`;
    const i = pairs.findIndex(([n]) => n === name);
    if (i >= 0) pairs[i] = [name, value]; else pairs.push([name, value]);
  };
  set('new', 'true');
  set('completed_on', completedOn);
  set('comment', comment);
  if (purchased !== undefined) set('purchased', purchased);
  return pairs;
}

/** Field names the caller supplies itself rather than echoing from the page. */
const OVERRIDDEN = /^(trailmen-select\[\]|badge-select|badge-select-multiple\[\]|level-select)$/;

/**
 * The complete body for `POST /advancement/index` that adds one instance.
 *
 * page form (minus the fields we set ourselves, minus any panels)
 *   + this trailman and this award
 *   + every panel from the fragment, with one empty slot filled
 *
 * @returns {Array<[string,string]>} ordered pairs — NOT an object, because
 *   the form legitimately repeats names and order is part of fidelity.
 */
function buildSaveBody({ pageHtml, fragmentHtml, slotId, trailmanId, awardId, levelSelect, completedOn, comment, purchased }) {
  const outer = serializeForm(pageHtml).filter(([n]) => !OVERRIDDEN.test(n) && !SLOT_RE.test(n));
  return [
    ...outer,
    ['level-select', levelSelect],
    ['trailmen-select[]', trailmanId],
    ['badge-select', awardId],
    ...panelPairs(fragmentHtml, { slotId, completedOn, comment, purchased }),
  ];
}

module.exports = {
  SLOT_RE, serializeForm, parseStandardFragment, firstEmptySlot, filledCount,
  savedSignature, panelPairs, buildSaveBody,
};

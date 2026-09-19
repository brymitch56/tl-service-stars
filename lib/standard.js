'use strict';
/**
 * standard.js — read the Standard-view fragment that
 * `POST /advancement/badge-tracker-view` returns, so the push can fill one
 * slot and hand everything else back untouched.
 *
 * WHAT THE FRAGMENT LOOKS LIKE (read live, 2026-09-19). A multi-instance
 * award renders a repeated panel, each keyed by an advancement record id:
 *
 *   <input type="hidden" name="new-<adId>"          value="true">
 *   <input type="text"   name="completed_on-<adId>" value="">
 *   <input type="text"   name="awarded_on-<adId>"   value="">
 *   <input type="text"   name="purchased-<adId>"    value="">
 *   <textarea            name="comment-<adId>"></textarea>
 *
 * `purchased-` is a TEXT input, not a checkbox — it is a Krajee checkbox-x
 * widget whose value is the string "0" or "1". Treating it as a checkbox and
 * omitting it clears the flag, so it is echoed verbatim like everything else.
 *
 * SLOT IDS ARE NOT RESERVATIONS. Every fetch of the fragment mints fresh
 * `new-` ids; an older one still works, but two pushes built from the same
 * fetch would collide. So the push fetches the fragment immediately before
 * each save and never reuses one.
 *
 * ECHO EVERYTHING. The save posts the whole form, so a field left out is a
 * field cleared. `toFields()` rebuilds the exact payload with one slot
 * changed — that is the only safe way to add an instance without disturbing
 * the ones already on the record.
 */
const { formsIn, inputsIn, textareasIn, attrOf } = require('./html');

const SLOT_RE = /^(new|completed_on|awarded_on|purchased|comment)-([a-z0-9]{8,})$/i;

/**
 * @returns {{
 *   slots: Array<{adId, isNew, completedOn, awardedOn, purchased, comment}>,
 *   others: Object<string,string|string[]>,   // every non-slot field, echoed
 *   warnings: string[]
 * }}
 */
function parseStandardFragment(html) {
  const warnings = [];
  const page = String(html || '');
  // The fragment may or may not carry its own <form> wrapper; when it does
  // not, scan the whole thing.
  const forms = formsIn(page);
  const body = forms.length ? forms.map((f) => f.body).join('\n') : page;

  const byId = new Map();
  const others = {};
  const slotOf = (adId) => {
    if (!byId.has(adId)) {
      byId.set(adId, { adId, isNew: false, completedOn: '', awardedOn: '', purchased: '', comment: '' });
    }
    return byId.get(adId);
  };

  const addOther = (name, value) => {
    if (others[name] === undefined) others[name] = value;
    else if (Array.isArray(others[name])) others[name].push(value);
    else others[name] = [others[name], value];
  };

  for (const i of inputsIn(body)) {
    const m = SLOT_RE.exec(i.name);
    if (!m) {
      // Radios and unchecked checkboxes are not submitted by a browser; do
      // not invent them here either.
      if ((i.type === 'checkbox' || i.type === 'radio') && !i.checked) continue;
      addOther(i.name, i.value);
      continue;
    }
    const s = slotOf(m[2]);
    switch (m[1].toLowerCase()) {
      case 'new': s.isNew = /^(true|1)$/i.test(i.value); break;
      case 'completed_on': s.completedOn = i.value; break;
      case 'awarded_on': s.awardedOn = i.value; break;
      case 'purchased': s.purchased = i.value; break;
      default: break;
    }
  }
  for (const t of textareasIn(body)) {
    const m = SLOT_RE.exec(t.name);
    if (!m) { addOther(t.name, t.value); continue; }
    if (m[1].toLowerCase() === 'comment') slotOf(m[2]).comment = t.value;
  }
  // <select> values are part of the form too (style-select, level-select …).
  for (const s of selectsIn(body)) {
    if (SLOT_RE.test(s.name)) continue;
    for (const v of s.values) addOther(s.name, v);
  }

  const slots = [...byId.values()];
  if (!slots.length) warnings.push('no award slots found in the Standard-view fragment');
  return { slots, others, warnings };
}

/** Named <select> elements with their selected option values. */
function selectsIn(body) {
  const out = [];
  const re = /<select\b([^>]*)>([\s\S]*?)<\/select\s*>/gi;
  let m;
  while ((m = re.exec(body || ''))) {
    const name = attrOf(m[1], 'name');
    if (!name) continue;
    const values = [];
    const ore = /<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi;
    let o;
    while ((o = ore.exec(m[2]))) {
      if (!/\bselected\b/i.test(o[1])) continue;
      const v = attrOf(o[1], 'value');
      values.push(v === null ? o[2].replace(/<[^>]+>/g, '').trim() : v);
    }
    out.push({ name, values, multiple: /\bmultiple\b/i.test(m[1]) });
  }
  return out;
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
 * Rebuild the full POST payload with exactly one slot changed.
 *
 * Every other slot and every other field goes back byte for byte, because
 * `POST /advancement/index` replaces the whole form: anything omitted is
 * treated as cleared.
 *
 * @param {object} parsed          parseStandardFragment() output
 * @param {object} fill            { adId, completedOn, comment, awardedOn?, purchased? }
 * @param {object} [extra]         fields the caller must set (_csrf, selects)
 */
function toFields(parsed, fill, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(parsed.others)) out[k] = v;
  for (const s of parsed.slots) {
    const isTarget = fill && s.adId === fill.adId;
    out[`new-${s.adId}`] = s.isNew ? 'true' : 'false';
    out[`completed_on-${s.adId}`] = isTarget ? (fill.completedOn || '') : s.completedOn;
    out[`awarded_on-${s.adId}`] = isTarget && fill.awardedOn !== undefined ? fill.awardedOn : s.awardedOn;
    out[`purchased-${s.adId}`] = isTarget && fill.purchased !== undefined ? fill.purchased : s.purchased;
    out[`comment-${s.adId}`] = isTarget ? (fill.comment || '') : s.comment;
  }
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

module.exports = { parseStandardFragment, firstEmptySlot, filledCount, toFields, selectsIn, SLOT_RE };

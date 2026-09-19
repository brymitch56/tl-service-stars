'use strict';
/**
 * Synthetic Trail Life Connect markup. Every name here is invented and every
 * hashid is made up — nothing in this file came from a real roster, and
 * nothing that did may ever be added to it (see CLAUDE.md).
 *
 * The SHAPES, though, are exactly the ones the live portal renders: the grid
 * ids, the column labels, the footer row, the verified toggle href and the
 * Standard-view slot names were all read from a live session and reproduced
 * here so the parsers are tested against what they will actually meet.
 */

const TRAILMAN_A = 'uaaaaaaaaaaa';
const TRAILMAN_B = 'ubbbbbbbbbbb';

/** One service-ledger row. `key` is the TLC service record id. */
function ledgerRow({ key, date, act, hours, level, verified = true }) {
  const toggle = verified
    ? `<a class="verified_toggle" href="/fields/toggleServiceActive/${key}?attribute=verified" title="Verified" rel="tooltip"><span class="glyphicon glyphicon-ok toggle-green"></span></a>`
    : `<a class="verified_toggle" href="/fields/toggleServiceActive/${key}?attribute=verified" title="Not Verified" rel="tooltip"><span class="glyphicon glyphicon-remove toggle-red"></span></a>`;
  return `<tr data-key="${key}"><td>${date}</td><td>${act}</td><td>${hours}</td>`
    + `<td>${level}</td><td>${toggle}</td><td>Menu</td></tr>`;
}

/**
 * The service-ledger grid as the profile renders it, footer included.
 * `declared` defaults to the number of rows; pass a bigger number to
 * reproduce the 100-row cap (the footer says 172, the page holds 100).
 */
function ledgerGrid(rows, { declared = null, totalHours = null } = {}) {
  const n = declared === null ? rows.length : declared;
  const total = totalHours === null ? '' : totalHours;
  return '<div class="grid-view" id="w10-container"><table>'
    + '<thead><tr><th>Activity Date</th><th>Act of Service</th><th>Time Spent</th>'
    + '<th>Event Level</th><th>Verified</th><th>Menu</th></tr>'
    + '<tr class="filters"><td></td><td></td><td></td><td></td><td></td><td></td></tr></thead>'
    + `<tbody>${rows.join('')}`
    + `<tr class="kv-page-summary"><td>Total Servant Service Records: ${n}</td><td></td><td>${total}</td>`
    + '<td></td><td></td><td></td></tr>'
    + '</tbody></table></div>';
}

/** The empty-grid placeholder a trailman with no service records gets. */
const EMPTY_LEDGER = '<div class="grid-view" id="w10-container"><table>'
  + '<thead><tr><th>Activity Date</th><th>Act of Service</th><th>Time Spent</th>'
  + '<th>Event Level</th><th>Verified</th><th>Menu</th></tr></thead>'
  + '<tbody><tr class="empty"><td colspan="6">No results found.</td></tr>'
  + '<tr class="kv-page-summary"><td>Total Servant Service Records: 0</td><td></td><td></td>'
  + '<td></td><td></td><td></td></tr></tbody></table></div>';

/** One awards-grid row. `adId` is the advancement record id. */
function awardRow({ adId, trailmanId, program, title, completed, awarded }) {
  const dates = [completed ? `Completed on: ${completed}` : null, awarded ? `Awarded on: ${awarded}` : null,
    'Purchased:'].filter(Boolean).join(' ');
  return `<tr data-key="${adId}|${trailmanId}"><td></td><td>${program}</td><td>${title}</td>`
    + `<td>100%</td><td>${dates}</td><td>Menu</td></tr>`;
}

function awardsGrid(rows) {
  return '<div class="grid-view" id="advancement_grid-container"><table>'
    + '<thead><tr><th></th><th>Program</th><th>Awards Title</th><th>Progress</th>'
    + '<th>Completed On</th><th>Menu</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody></table></div>`;
}

/** A whole profile page: the awards grid, an activities grid, the ledger. */
function profilePage(trailmanId, { ledger, awards }) {
  return `<!doctype html><html><head><meta name="csrf-token" content="test-csrf"></head><body>`
    + `<a href="/profile/${trailmanId}?tab=overview">Profile</a>`
    + awardsGrid(awards)
    // The activities grid also carries hours; the parser must ignore it, so
    // it is here on purpose with numbers that would break the totals.
    + '<div class="grid-view" id="w1-container"><table><thead><tr><th>Activity Date</th><th>Activity</th>'
    + '<th>Event Type</th><th>Event Level</th><th>Tent Camping Nights</th><th>Cabin Camping Nights</th>'
    + '<th>Hiking Miles</th><th>Servant Service Hours</th><th>Paddling Miles</th><th>Cycling Miles</th>'
    + '<th>Verified</th><th>Menu</th></tr></thead><tbody>'
    + '<tr data-key="epzzzzzzzzzz"><td>12/08/2025</td><td>Regular Weekly Meeting</td><td>Troop Meeting</td>'
    + '<td>Navigator</td><td></td><td></td><td></td><td>999</td><td></td><td></td><td></td><td>Menu</td></tr>'
    + '</tbody></table></div>'
    + ledger
    + '</body></html>';
}

/** /advancement/index — the page shell with the trailman picker. */
function advancementIndex(trailmen) {
  const opts = [
    '<option value="j8e296a067a3">All Navigators</option>',
    '<option value="x1ff1de77400">All Adventurers</option>',
    ...trailmen.map((t) => `<option value="${t.id}">${t.name}</option>`),
  ].join('');
  return '<!doctype html><html><head><meta name="csrf-token" content="test-csrf"></head><body>'
    + `<select id="trailmen-select" name="trailmen-select[]" multiple>${opts}</select>`
    + '<select id="badge-select" name="badge-select">'
    + '<option value="acc66f374e08">Navigator Service Star</option>'
    + '<option value="acb527dc22b8">Adventurer Service Star</option></select>'
    + '</body></html>';
}

/**
 * The Standard-view fragment for one award: `filled` existing instances plus
 * `empty` fresh slots. Slot ids are minted per call, exactly as the portal
 * mints them per fetch.
 */
let slotSeq = 0;
function standardFragment({ filled = [], empty = 2 } = {}) {
  // The live fragment is ONLY the award panels: no <form>, no _csrf, none of
  // the page's own controls (verified 2026-09-19 — the response is ~54 KB of
  // panel markup and nothing else).
  const parts = [];
  for (const f of filled) {
    // An instance already on the record carries NO `new-` input (verified
    // against the live portal, 2026-09-19) — not `new=false`.
    parts.push(
      `<input type="text" name="completed_on-${f.adId}" value="${f.completed || ''}">`,
      `<input type="text" name="awarded_on-${f.adId}" value="${f.awarded || ''}">`,
      `<input type="text" name="purchased-${f.adId}" value="${f.purchased || '0'}">`,
      `<textarea name="comment-${f.adId}">${f.comment || ''}</textarea>`,
    );
  }
  for (let i = 0; i < empty; i++) {
    slotSeq += 1;
    const id = `adnew${String(slotSeq).padStart(7, '0')}`;
    parts.push(
      `<input type="hidden" name="new-${id}" value="true">`,
      `<input type="text" name="completed_on-${id}" value="">`,
      `<input type="text" name="awarded_on-${id}" value="">`,
      `<input type="text" name="purchased-${id}" value="">`,
      `<textarea name="comment-${id}"></textarea>`,
    );
  }
  return parts.join('');
}

/**
 * The /advancement/index PAGE form, as the server sends it. This is what the
 * save body is built from; the field names, the radios and the Krajee
 * checkbox-x TEXT inputs are the live ones (2026-09-19).
 */
function advancementPage({ level = 'navadv', today = '09/19/2026' } = {}) {
  return '<!doctype html><html><head><meta name="csrf-token" content="page-csrf"></head><body>'
    + '<form id="form-advancement" action="/advancement/index" method="post">'
    + '<input type="hidden" name="_csrf" value="page-csrf">'
    + '<input type="radio" name="style-select" value="standard" checked>'
    + '<input type="radio" name="style-select" value="grid">'
    + '<input type="radio" name="style-select" value="summary">'
    + '<input type="radio" name="level-select" value="wt">'
    + `<input type="radio" name="level-select" value="navadv"${level === 'navadv' ? ' checked' : ''}>`
    + '<select id="trailmen-select" name="trailmen-select[]" multiple></select>'
    + '<select id="badge-select" name="badge-select"><option value="" selected></option></select>'
    + `<input type="text" name="date-specified" value="${today}" readonly>`
    + '<input type="text" name="lock-checked" value="1" class="cbx-loading">'
    + '<input type="text" name="show-completed-checked" value="0" class="cbx-loading">'
    + '<input type="text" name="show-items-checked" value="0" class="cbx-loading">'
    + '<textarea name="comment-specified"></textarea>'
    + '<select name="event-attendance"><option value="" selected>Search For Event</option></select>'
    + '<input type="text" name="track-attendance" value="0" class="cbx-loading">'
    + '<button type="submit" name="submit-progress" value="go">Submit Progress</button>'
    + '</form></body></html>';
}

const LOGIN_PAGE = '<!doctype html><html><head><meta name="csrf-token" content="test-csrf"></head><body>'
  + '<form method="post" action="/login"><input type="hidden" name="_csrf" value="test-csrf">'
  + '<input type="email" name="LoginForm[email]"><input type="password" name="LoginForm[password]">'
  + '</form></body></html>';

const CODE_PAGE = '<!doctype html><html><head><meta name="csrf-token" content="test-csrf"></head><body>'
  + '<p>We sent a code to your phone ending 1234.</p>'
  + '<form method="post" action="/login/verify"><input type="hidden" name="_csrf" value="code-csrf">'
  + '<input type="text" name="VerifyForm[code]"></form></body></html>';

const DASHBOARD = '<!doctype html><html><head><meta name="csrf-token" content="signed-in-csrf"></head>'
  + '<body><h1>Dashboard</h1></body></html>';

module.exports = {
  TRAILMAN_A, TRAILMAN_B,
  ledgerRow, ledgerGrid, EMPTY_LEDGER, awardRow, awardsGrid, profilePage,
  advancementIndex, advancementPage, standardFragment, LOGIN_PAGE, CODE_PAGE, DASHBOARD,
};

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setupDb, fakeClient } = require('./helpers');

const { db } = setupDb();
const sync = require('../server/lib/sync');
const push = require('../server/lib/starspush');
const { setSetting } = require('../server/lib/settings');
const F = require('./fixtures');

const row = F.ledgerRow;

/** Each scenario gets its own trailman, so tests cannot contaminate each other. */
let seq = 0;
function newTrailmanId() {
  seq += 1;
  return `u${String(seq).padStart(11, '0')}`;
}

/**
 * A portal that really records what we post: an accepted save appends an
 * award row, so the read-back sees one more instance. That read-back is the
 * only thing the push trusts, so the fake has to model it honestly.
 */
function livePortal({ acceptSave = true, startingStars = [], hours = '20', emptySlots = 2 } = {}) {
  const id = newTrailmanId();
  const state = { id, stars: [...startingStars], saves: [], viewParams: [], savedSeq: 0 };
  const ledgerRows = [row({ key: `${id}-s1`, date: '02/02/2025', act: 'Service day', hours, level: 'Navigator' })];
  const starRow = (s) => F.awardRow({
    adId: s.adId, trailmanId: id, program: 'Navigators', title: 'Navigator Service Star', completed: s.completed,
  });
  const routes = {
    'GET /login': F.DASHBOARD,
    // The page shell serves two jobs, as it does live: the trailman picker
    // for the roster read, and the form the save body is built from.
    'GET /advancement/index': () => F.advancementIndex([{ id, name: 'Rivers, Sam' }]) + F.advancementPage(),
    [`GET /profile/${id}`]: () => F.profilePage(id, {
      ledger: F.ledgerGrid(ledgerRows, { totalHours: hours }),
      awards: state.stars.map(starRow),
    }),
    // Panels only — no form, no csrf — exactly as the live endpoint answers.
    'POST /advancement/badge-tracker-view': ({ opts }) => {
      const p = new URLSearchParams(opts.body);
      state.viewParams.push([...p.keys()]);
      return F.standardFragment({
        filled: state.stars.map((s) => ({ adId: s.adId, completed: s.completed, comment: s.comment || '', purchased: '1' })),
        empty: emptySlots,
      });
    },
    'POST /advancement/index': ({ opts }) => {
      const body = new URLSearchParams(opts.body);
      state.saves.push(body);
      if (acceptSave) {
        for (const [k, v] of body) {
          const m = /^completed_on-(ad\w{10})$/.exec(k);
          if (m && v && !state.stars.some((s) => s.adId === m[1])) {
            state.savedSeq += 1;
            // A real advancement record id: "ad" + exactly 10 characters.
            state.stars.push({
              adId: `adsv${String(state.savedSeq).padStart(8, '0')}`,
              completed: v,
              comment: body.get(`comment-${m[1]}`) || '',
            });
            break;
          }
        }
      }
      return '<html><body><div class="alert-success">Saved</div></body></html>';
    },
  };
  return { id, routes, state };
}

/** Sync the scenario, approve the star it proposes, and queue it. */
async function seedApproved(portal) {
  await sync.runSync({ trigger: 'test', client: fakeClient(portal.routes) });
  const tm = db.prepare('SELECT * FROM trailman WHERE tlc_user_id = ?').get(portal.id);
  const p = db.prepare("SELECT * FROM proposal WHERE trailman_id = ? AND status = 'proposed' ORDER BY ordinal")
    .get(tm.id);
  assert.ok(p, 'the sync should have proposed a star for this scenario');
  db.prepare("UPDATE proposal SET status = 'approved' WHERE id = ?").run(p.id);
  return { proposal: p, trailman: tm, queued: push.enqueue(p.id, 'tester') };
}

test('nothing is written while the push switch is off', async () => {
  setSetting('push_enabled', false);
  const portal = livePortal();
  const { proposal } = await seedApproved(portal);
  const r = await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  assert.equal(r.ok, false);
  assert.match(r.error, /switched off/);
  assert.equal(portal.state.saves.length, 0, 'the portal must not be touched');
  assert.equal(db.prepare('SELECT state FROM push_queue WHERE proposal_id = ?').get(proposal.id).state, 'queued');
});

test('with the switch on, a star is written and proved by read-back', async () => {
  setSetting('push_enabled', true);
  const portal = livePortal();
  const { proposal } = await seedApproved(portal);
  const r = await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  assert.equal(r.summary.confirmed, 1, JSON.stringify(r.warnings));
  assert.equal(portal.state.saves.length, 1, 'exactly one save');
  const q = db.prepare('SELECT * FROM push_queue WHERE proposal_id = ?').get(proposal.id);
  assert.equal(q.state, 'confirmed');
  assert.ok(q.ad_id, 'the id of the new instance is recorded');
  assert.equal(db.prepare('SELECT status FROM proposal WHERE id = ?').get(proposal.id).status, 'recorded');
});

test('the save echoes the whole form, so an existing instance is never cleared', async () => {
  setSetting('push_enabled', true);
  // 40 Navigator hours with one star already on record = a second star owed.
  const portal = livePortal({ hours: '40', startingStars: [{ adId: 'adexisting01', completed: '04/17/2025' }] });
  await seedApproved(portal);
  await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });

  const body = portal.state.saves[0];
  assert.ok(body, 'a save should have been posted');
  assert.equal(body.get('completed_on-adexisting01'), '04/17/2025',
    'the instance already on the record must go back unchanged');
  // The portal sends NO `new-` input for an instance that already exists
  // (verified live, 2026-09-19), so the echo must not invent one.
  assert.equal(body.get('new-adexisting01'), null, 'an existing instance has no new- field to echo');

  // The page form's own controls must all travel — the fragment carries none
  // of them, so a body built from the fragment alone would drop every one.
  assert.equal(body.get('date-specified'), '09/19/2026');
  assert.equal(body.get('lock-checked'), '1', 'a Krajee checkbox-x is a TEXT input and is always sent');
  assert.equal(body.get('show-completed-checked'), '0');
  assert.equal(body.get('show-items-checked'), '0');
  assert.equal(body.get('track-attendance'), '0');
  assert.ok(body.get('_csrf'), 'the save carries the form token');
  // `comment-specified` / `date-specified` are page-level "apply to all"
  // controls, not award slots: echoed as themselves, with no phantom slot.
  assert.equal(body.get('comment-specified'), '', 'the page-level comment is echoed');
  assert.equal(body.get('new-specified'), null, 'no phantom slot for comment-specified');
  assert.equal(body.get('completed_on-specified'), null, 'no phantom slot for comment-specified');

  assert.equal(body.get('badge-select'), 'acc66f374e08', 'the Navigator Service Star award id');
  assert.equal(body.get('trailmen-select[]'), portal.id);
  assert.equal(body.get('level-select'), 'navadv', 'the level RADIO value, not a level hashid');
  assert.equal(body.getAll('level-select').length, 1, 'set once, not echoed twice');
  assert.equal(body.get('style-select'), 'standard');
  // Exactly one empty slot was filled, and with a portal-format date.
  const filled = [...body].filter(([k, v]) => /^completed_on-/.test(k) && v);
  assert.equal(filled.length, 2, 'the existing instance plus the one new one');
  assert.ok(filled.every(([, v]) => /^\d{2}\/\d{2}\/\d{4}$/.test(v)), 'dates go over as MM/DD/YYYY');
});

test('an unconfirmed save is HELD, and never retried', async () => {
  setSetting('push_enabled', true);
  // A portal that answers 200 but records nothing — the real failure mode.
  const portal = livePortal({ acceptSave: false });
  const { proposal } = await seedApproved(portal);
  const r = await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  assert.equal(r.summary.confirmed, 0);
  assert.equal(r.summary.held, 1);
  const q = db.prepare('SELECT * FROM push_queue WHERE proposal_id = ?').get(proposal.id);
  assert.equal(q.state, 'held');
  assert.match(q.detail, /not confirmed by read-back/);
  assert.equal(db.prepare('SELECT status FROM proposal WHERE id = ?').get(proposal.id).status, 'approved',
    'an unconfirmed star must NOT be marked recorded');

  const savesBefore = portal.state.saves.length;
  const again = await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  assert.equal(again.summary.attempted, 0, 'a held row is never picked up again on its own');
  assert.equal(portal.state.saves.length, savesBefore, 'and the portal is not written to twice');
});

test('a held row moves only when a human requeues it', async () => {
  setSetting('push_enabled', true);
  const portal = livePortal({ acceptSave: false });
  const { proposal } = await seedApproved(portal);
  await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  const q = db.prepare('SELECT * FROM push_queue WHERE proposal_id = ?').get(proposal.id);
  assert.equal(q.state, 'held');
  assert.equal(push.requeue(q.id, 'tester').state, 'queued');
  assert.equal(push.cancel(q.id, 'tester').state, 'cancelled');
  assert.throws(() => push.requeue(q.id, 'tester'), /held or failed/);
});

test('the portal offering no empty slot is a hold, not a guess', async () => {
  setSetting('push_enabled', true);
  // Slots exist (one filled instance) but none are free to write into.
  const portal = livePortal({ hours: '40', emptySlots: 0, startingStars: [{ adId: 'adfull000001', completed: '04/17/2025' }] });
  const { proposal } = await seedApproved(portal);
  const r = await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  assert.equal(r.summary.held, 1);
  assert.equal(portal.state.saves.length, 0, 'never post into a form with nowhere to put the instance');
  assert.match(db.prepare('SELECT detail FROM push_queue WHERE proposal_id = ?').get(proposal.id).detail,
    /no empty slot/);
});

test('an unreadable entry form is a hold too', async () => {
  setSetting('push_enabled', true);
  const portal = livePortal({ emptySlots: 0 });
  const { proposal } = await seedApproved(portal);
  const r = await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  assert.equal(r.summary.held, 1);
  assert.equal(portal.state.saves.length, 0);
  assert.match(db.prepare('SELECT detail FROM push_queue WHERE proposal_id = ?').get(proposal.id).detail,
    /could not read the entry form/);
});

test('a bad completed-on date is refused before anything is posted', async () => {
  setSetting('push_enabled', true);
  const portal = livePortal();
  const { queued } = await seedApproved(portal);
  db.prepare("UPDATE push_queue SET completed_on = '13/45/2026' WHERE id = ?").run(queued.id);
  const r = await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  assert.equal(r.summary.failed, 1);
  assert.equal(portal.state.saves.length, 0, 'nothing may be posted with an unreadable date');
  assert.match(db.prepare('SELECT detail FROM push_queue WHERE id = ?').get(queued.id).detail, /unreadable/);
});

test('only an approved proposal can be queued, and never twice', async () => {
  const portal = livePortal();
  await sync.runSync({ trigger: 'test', client: fakeClient(portal.routes) });
  const tm = db.prepare('SELECT * FROM trailman WHERE tlc_user_id = ?').get(portal.id);
  const p = db.prepare("SELECT * FROM proposal WHERE trailman_id = ? AND status = 'proposed'").get(tm.id);
  assert.throws(() => push.enqueue(p.id, 'tester'), /Only an approved star/);
  db.prepare("UPDATE proposal SET status = 'approved' WHERE id = ?").run(p.id);
  assert.equal(push.enqueue(p.id, 'tester').id, push.enqueue(p.id, 'tester').id,
    'queueing twice must not create a second write');
});

test('the fragment is requested with the AJAX view own parameter names', async () => {
  setSetting('push_enabled', true);
  const portal = livePortal();
  await seedApproved(portal);
  await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  // Sending the FORM's field names here gets "This action can only be used in
  // AJAX mode." and a 42-byte body — the view takes different names entirely.
  assert.ok(portal.state.viewParams.length, 'the entry form was fetched');
  for (const keys of portal.state.viewParams) {
    assert.deepEqual(keys.sort(),
      ['_csrf', 'badges', 'event_id', 'level', 'lockedChecked', 'style', 'track_attendance', 'trailmen[]'].sort());
  }
});

test('a pre-existing instance changing during the save is a hold', async () => {
  setSetting('push_enabled', true);
  const portal = livePortal({ hours: '40', startingStars: [{ adId: 'adexisting01', completed: '04/17/2025' }] });
  const { proposal } = await seedApproved(portal);
  // The portal writes the new star but also quietly alters the old one.
  const origin = portal.routes['POST /advancement/index'];
  let saved = false;
  portal.routes['POST /advancement/index'] = (ctx) => {
    const out = origin(ctx);
    if (!saved) { saved = true; portal.state.stars[0].completed = '01/01/2000'; }
    return out;
  };
  const r = await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  assert.equal(r.summary.confirmed, 0);
  assert.equal(r.summary.held, 1);
  assert.match(db.prepare('SELECT detail FROM push_queue WHERE proposal_id = ?').get(proposal.id).detail,
    /already on the record changed/);
});

test('a session lost mid-save is an auth failure, not a silent hold', async () => {
  setSetting('push_enabled', true);
  const portal = livePortal();
  const { proposal } = await seedApproved(portal);
  portal.routes['POST /advancement/index'] = () =>
    '<html><body><form><input type="password" name="LoginForm[password]"></form></body></html>';
  const r = await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });
  assert.equal(r.summary.held, 1);
  assert.match(db.prepare('SELECT detail FROM push_queue WHERE proposal_id = ?').get(proposal.id).detail,
    /session was lost during the save/);
});

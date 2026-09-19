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
  const state = { id, stars: [...startingStars], saves: [], savedSeq: 0 };
  const ledgerRows = [row({ key: `${id}-s1`, date: '02/02/2025', act: 'Service day', hours, level: 'Navigator' })];
  const starRow = (s) => F.awardRow({
    adId: s.adId, trailmanId: id, program: 'Navigators', title: 'Navigator Service Star', completed: s.completed,
  });
  const routes = {
    'GET /login': F.DASHBOARD,
    'GET /advancement/index': F.advancementIndex([{ id, name: 'Rivers, Sam' }]),
    [`GET /profile/${id}`]: () => F.profilePage(id, {
      ledger: F.ledgerGrid(ledgerRows, { totalHours: hours }),
      awards: state.stars.map(starRow),
    }),
    'POST /advancement/badge-tracker-view': () => F.standardFragment({
      filled: state.stars.map((s) => ({ adId: s.adId, completed: s.completed })),
      empty: emptySlots,
    }),
    'POST /advancement/index': ({ opts }) => {
      const body = new URLSearchParams(opts.body);
      state.saves.push(body);
      if (acceptSave) {
        for (const [k, v] of body) {
          const m = /^completed_on-(ad\w+)$/.exec(k);
          if (m && v && !state.stars.some((s) => s.adId === m[1])) {
            state.savedSeq += 1;
            // A real advancement record id: "ad" + exactly 10 characters.
            state.stars.push({ adId: `adsv${String(state.savedSeq).padStart(8, '0')}`, completed: v });
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
  const portal = livePortal({ hours: '40', startingStars: [{ adId: 'adexisting1', completed: '04/17/2025' }] });
  await seedApproved(portal);
  await push.runPush({ actor: 'tester', client: fakeClient(portal.routes) });

  const body = portal.state.saves[0];
  assert.ok(body, 'a save should have been posted');
  assert.equal(body.get('completed_on-adexisting1'), '04/17/2025',
    'the instance already on the record must go back unchanged');
  assert.equal(body.get('new-adexisting1'), 'false');
  assert.equal(body.get('lock-checked'), null, 'an unchecked box must not be invented');
  assert.equal(body.get('show-items-checked'), '1', 'a checked box must be echoed');
  assert.equal(body.get('badge-select'), 'acc66f374e08', 'the Navigator Service Star award id');
  assert.equal(body.get('trailmen-select[]'), portal.id);
  assert.equal(body.get('level-select'), 'j8e296a067a3', 'the Navigator level id');
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
  const portal = livePortal({ hours: '40', emptySlots: 0, startingStars: [{ adId: 'adfull00001', completed: '04/17/2025' }] });
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

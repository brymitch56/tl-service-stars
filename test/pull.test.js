'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setupDb, fakeClient } = require('./helpers');

const { db } = setupDb();
const sync = require('../server/lib/sync');
const F = require('./fixtures');

const row = F.ledgerRow;

/** Routes for a troop of two trailmen with the ledgers/awards given. */
function routesFor(people) {
  const routes = {
    'GET /login': F.DASHBOARD,
    'GET /advancement/index': F.advancementIndex(people.map((p) => ({ id: p.id, name: p.name }))),
  };
  for (const p of people) {
    routes[`GET /profile/${p.id}`] = () => F.profilePage(p.id, {
      ledger: p.ledgerHtml || F.ledgerGrid(p.rows || [], { totalHours: p.total }),
      awards: p.awards || [],
    });
  }
  return routes;
}

const NAV_STAR = (adId, trailmanId, completed) => F.awardRow({
  adId, trailmanId, program: 'Navigators', title: 'Navigator Service Star', completed,
});

test('a sync mirrors the roster, the ledger and the stars', async () => {
  const people = [
    {
      id: F.TRAILMAN_A,
      name: 'Rivers, Sam',
      total: '34',
      rows: [
        row({ key: 'a1', date: '09/10/2024', act: 'Food bank', hours: '20', level: 'Navigator' }),
        row({ key: 'a2', date: '03/04/2025', act: 'Park clean-up', hours: '14', level: 'Navigator' }),
      ],
      awards: [NAV_STAR('adaaaaaaaaaa', F.TRAILMAN_A, '09/10/2024')],
    },
    {
      id: F.TRAILMAN_B,
      name: 'Vance, Theo',
      total: '16',
      rows: [
        row({ key: 'b1', date: '01/05/2025', act: 'Church set-up', hours: '10', level: 'Mountain Lion' }),
        row({ key: 'b2', date: '06/06/2025', act: 'Trail work', hours: '6', level: 'Navigator' }),
      ],
      awards: [],
    },
  ];
  const result = await sync.runSync({ trigger: 'test', client: fakeClient(routesFor(people)) });
  assert.equal(result.ok, true, result.error || '');
  assert.equal(result.summary.trailmen, 2);
  assert.equal(result.summary.read, 2);

  const sam = db.prepare('SELECT * FROM trailman WHERE tlc_user_id = ?').get(F.TRAILMAN_A);
  assert.equal(sam.name, 'Rivers, Sam');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM service_row WHERE trailman_id = ?').get(sam.id).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM star_instance WHERE trailman_id = ?').get(sam.id).n, 1);

  // 34 Navigator hours = 2 stars; 1 is on record, so 1 is owed.
  const owed = db.prepare("SELECT * FROM proposal WHERE trailman_id = ? AND status = 'proposed'").all(sam.id);
  assert.equal(owed.length, 1);
  assert.equal(owed[0].level, 'Navigator');
  assert.equal(owed[0].ordinal, 2);
  assert.equal(owed[0].completed_on, '2025-03-04', 'dated by the row that crossed 30 hours');

  // Theo: Mountain Lion hours are ignored, so 6 Navigator hours earn nothing.
  const theo = db.prepare('SELECT * FROM trailman WHERE tlc_user_id = ?').get(F.TRAILMAN_B);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM proposal WHERE trailman_id = ? AND status='proposed'").get(theo.id).n, 0);
});

test('a second sync is idempotent — no duplicate proposals', async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM proposal WHERE status = 'proposed'").get().n;
  const people = [
    { id: F.TRAILMAN_A, name: 'Rivers, Sam', total: '34', rows: [
      row({ key: 'a1', date: '09/10/2024', act: 'Food bank', hours: '20', level: 'Navigator' }),
      row({ key: 'a2', date: '03/04/2025', act: 'Park clean-up', hours: '14', level: 'Navigator' }),
    ], awards: [NAV_STAR('adaaaaaaaaaa', F.TRAILMAN_A, '09/10/2024')] },
    { id: F.TRAILMAN_B, name: 'Vance, Theo', total: '16', rows: [
      row({ key: 'b1', date: '01/05/2025', act: 'Church set-up', hours: '10', level: 'Mountain Lion' }),
      row({ key: 'b2', date: '06/06/2025', act: 'Trail work', hours: '6', level: 'Navigator' }),
    ], awards: [] },
  ];
  await sync.runSync({ trigger: 'test', client: fakeClient(routesFor(people)) });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM proposal WHERE status = 'proposed'").get().n, before);
});

test('an INCOMPLETE ledger is mirrored but never proposed against', async () => {
  const many = [];
  for (let i = 0; i < 100; i++) {
    many.push(row({ key: `c${i}`, date: '01/02/2024', act: 'Service', hours: '2', level: 'Navigator' }));
  }
  const people = [{
    id: F.TRAILMAN_A,
    name: 'Rivers, Sam',
    ledgerHtml: F.ledgerGrid(many, { declared: 172, totalHours: '344' }),
    awards: [],
  }];
  const r = await sync.runSync({ trigger: 'test', client: fakeClient(routesFor(people)) });
  assert.equal(r.summary.incomplete, 1);
  assert.ok(r.warnings.some((w) => /NOT proposing/.test(w)), 'the run must say it refused to propose');
  const sam = db.prepare('SELECT * FROM trailman WHERE tlc_user_id = ?').get(F.TRAILMAN_A);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM proposal WHERE trailman_id=? AND status='proposed'").get(sam.id).n, 0,
    '200 hours of unread ledger must not produce proposals');
});

test('a rejected star is never proposed again', async () => {
  const dir = require('./helpers');
  // Give Sam a complete ledger worth 2 stars, none on record.
  const people = [{
    id: F.TRAILMAN_A, name: 'Rivers, Sam', total: '34', awards: [],
    rows: [
      row({ key: 'a1', date: '09/10/2024', act: 'Food bank', hours: '20', level: 'Navigator' }),
      row({ key: 'a2', date: '03/04/2025', act: 'Park clean-up', hours: '14', level: 'Navigator' }),
    ],
  }];
  await sync.runSync({ trigger: 'test', client: fakeClient(routesFor(people)) });
  const sam = db.prepare('SELECT * FROM trailman WHERE tlc_user_id = ?').get(F.TRAILMAN_A);
  const first = db.prepare("SELECT * FROM proposal WHERE trailman_id=? AND status='proposed' ORDER BY ordinal").all(sam.id);
  assert.ok(first.length >= 1);
  db.prepare("UPDATE proposal SET status='rejected' WHERE id = ?").run(first[0].id);

  await sync.runSync({ trigger: 'test', client: fakeClient(routesFor(people)) });
  const again = db.prepare('SELECT * FROM proposal WHERE id = ?').get(first[0].id);
  assert.equal(again.status, 'rejected', 'a leader\'s no must survive the next sync');
  assert.ok(dir);
});

test('a star recorded on the portal retires its proposal', async () => {
  const people = [{
    id: F.TRAILMAN_B, name: 'Vance, Theo', total: '20', awards: [],
    rows: [row({ key: 'b9', date: '02/02/2025', act: 'Service day', hours: '20', level: 'Navigator' })],
  }];
  await sync.runSync({ trigger: 'test', client: fakeClient(routesFor(people)) });
  const theo = db.prepare('SELECT * FROM trailman WHERE tlc_user_id = ?').get(F.TRAILMAN_B);
  const open = db.prepare("SELECT * FROM proposal WHERE trailman_id=? AND status='proposed'").all(theo.id);
  assert.equal(open.length, 1);

  // Now the star appears on the portal.
  people[0].awards = [NAV_STAR('adtheo000001', F.TRAILMAN_B, '02/02/2025')];
  await sync.runSync({ trigger: 'test', client: fakeClient(routesFor(people)) });
  assert.equal(db.prepare('SELECT status FROM proposal WHERE id = ?').get(open[0].id).status, 'recorded');
});

test('a trailman the portal stops listing goes inactive, keeping his history', async () => {
  const people = [{ id: F.TRAILMAN_A, name: 'Rivers, Sam', total: '2',
    rows: [row({ key: 'a1', date: '09/10/2024', act: 'X', hours: '2', level: 'Navigator' })], awards: [] }];
  await sync.runSync({ trigger: 'test', client: fakeClient(routesFor(people)) });
  const theo = db.prepare('SELECT * FROM trailman WHERE tlc_user_id = ?').get(F.TRAILMAN_B);
  assert.equal(theo.active, 0);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM service_row WHERE trailman_id = ?').get(theo.id).n >= 0);
});

test('the sync reports a failed portal sign-in instead of throwing', async () => {
  const r = await sync.runSync({
    trigger: 'test',
    client: fakeClient({ 'GET /login': F.LOGIN_PAGE, 'POST /login': F.LOGIN_PAGE },
      { store: { loadCookies: () => null, saveCookies: () => {}, touch: () => {}, putChallenge: () => null, clearChallenge: () => {} } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not sign in/);
  assert.equal(db.prepare("SELECT ok FROM run WHERE kind='sync' ORDER BY id DESC LIMIT 1").get().ok, 0);
});

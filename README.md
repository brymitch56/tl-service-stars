# Trail Life Service Stars

A small, self-hosted web app that works out which **Service Stars** the
trailmen in a Trail Life USA troop have earned, shows a leader the arithmetic
behind every one of them, and — once a leader approves and an admin turns the
switch on — records them back on Trail Life Connect.

It runs on the troop's own hardware (a Raspberry Pi is plenty), stores
everything in one SQLite file, and has no dependencies beyond Express and
better-sqlite3.

## What it does

- **Reads** each trailman's service ledger and awards grid from Trail Life
  Connect, and mirrors them locally.
- **Computes** stars from the troop's rules (below), showing counted hours,
  hours carried forward, stars earned, stars on the portal, and how far he is
  from the next one.
- **Proposes** the stars the hours say are owed, dated by the service record
  that crossed the threshold — not by the day the app noticed.
- **Records** approved stars on Trail Life Connect as new award instances,
  behind a switch that ships off, proving every save by reading it back.

## The star rules

| Level | Hours per star |
| --- | --- |
| Navigator | 15 |
| Adventurer | 20 |

- **Fox, Hawk and Mountain Lion hours never count** toward a star, and never
  carry forward. Navigator always starts from zero.
- **Navigator leftovers do carry forward** into Adventurer.
- Only **verified** hours count.
- More stars on the portal than the hours explain is raised for a leader to
  rule on, never silently undone. See *Stars the hours don't explain* below.

## Getting started

```bash
npm install
cp .env.example .env     # then edit it — at minimum set ADMIN_EMAILS
npm run migrate
npm start
```

On first run, with no accounts in the database, the app creates one for the
first address in `ADMIN_EMAILS` and prints a one-time password to the log.
Sign in with it; you will be asked to set your own password immediately.

Then, as an admin:

1. **Settings → Trail Life Connect**: save the portal account the app should
   read with, and press **Connect**. The portal will text a sign-in code —
   type it in. That is the only step that needs a person; from then on the
   nightly sync runs on its own until the portal expires the session.
2. **Trailmen → Sync now**: the first read mirrors the roster and takes each
   trailman's baseline (see below).
3. **Review**: approve or reject the stars the arithmetic says are owed.
4. **Settings → Recording stars**: leave this OFF until you have read a few
   proposals and agree with them. Approved stars queue up harmlessly until
   you turn it on.

## Stars the hours don't explain

Troops kept service hours on paper long before any of this, so a trailman can
hold more stars than his Trail Life Connect ledger accounts for. The app takes
a **baseline** for each trailman the first time it reads him, so those stars
are never treated as an error — and asks a leader, per trailman and per level,
which of three things is going on:

- **Stand on their own** (the default) — paper-era stars the ledger never
  held. They stack on top of what the hours earn, so the next star still needs
  a full allotment of new hours.
- **Earned on Woodlands hours** — the troop awarded them before Mountain Lion
  and Hawk hours were excluded. The stars stand and a *fixed* credit covers
  exactly the hours they needed, so every hour earned since counts toward the
  next star instead of paying the old ones back.
- **Restart this level from a date** — the stars stand and the level starts
  over: only hours from that date count, with nothing carried in.

After the baseline, a star appearing or disappearing that the hours cannot
explain is flagged on the trailman's page and in the sync log.

## Recording stars on the portal

`server/lib/starspush.js` is the only code in this repo that writes to Trail
Life Connect, and it is deliberately hard to do by accident:

- it ships **off** (`push_enabled`, admin-only);
- it writes **one star at a time**, re-fetching the entry form each time
  (the portal mints fresh slot ids on every fetch);
- it **echoes the whole form back**, so instances already on the record are
  never cleared;
- it **validates the date itself**, because the portal accepts nonsense dates
  and stores them as nothing;
- it **proves every save by reading the record back**, because this platform
  answers `200 OK` whether or not it wrote anything;
- an unconfirmed save is **held for a person and never retried** — a blind
  retry is how you end up with a duplicate star someone has to delete by hand.

## Signing in

Leaders sign in with an e-mail and a real password (at least 12 characters),
hashed with scrypt. Accounts are created by an admin, who issues a one-time
password shown once on screen; the leader must replace it at first sign-in.
Eight wrong passwords locks an account for fifteen minutes.

`ADMIN_EMAILS` in `.env` is the recovery hatch: those addresses are admins
whatever the database says, and the UI cannot demote or disable them. A
mistake in the app can never lock the troop out.

Anyone can change their own password from the account dialog (their name in
the header); every other session of theirs ends when they do. An admin can
edit a leader’s name, sign-in address and role from Settings. Changing the
address changes the credential, so that person is signed out everywhere and
signs back in at the new address with the same password — unless the address
is one of the `ADMIN_EMAILS`, which the UI leaves alone for the reason above.

## Deploying

See [`docs/pi-setup.md`](docs/pi-setup.md). In short: clone, `npm ci --omit=dev`,
`npm run migrate`, install the systemd unit in `deploy/`, and front it with a
Cloudflare Tunnel. The app binds `127.0.0.1` and expects TLS to be terminated
in front of it.

## Layout

```
lib/          pure logic, no database and no network
  html.js       HTML scanners shared by the parsers
  grid.js       the portal's GridView tables
  service.js    the service ledger and awards grid
  standard.js   the advancement entry form (for the push)
  stars.js      the arithmetic
  program.js    Trail Life award and level ids
  tlc.js        the HTTP client, with the read-only allow-list
  icon.js       the app mark
server/       the service: routes, database, jobs
public/       the UI (no framework, no build step)
test/         85 tests, synthetic fixtures only
```

`npm test` must pass before anything is pushed. The tests never touch a live
site.

## A note on what is in this repo

This is a public repository for a project that handles children's records.
Nothing that identifies a real person — names, hashids, hours, roster counts —
belongs in it, in code, tests, docs or commit messages. `CLAUDE.md` has the
full rule and applies to people as much as to assistants.

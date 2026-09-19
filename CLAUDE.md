# Instructions for AI assistants working in this repo

## THIS REPO IS PUBLIC — NEVER COMMIT PII. NO EXCEPTIONS.

Git history is permanent and this project serves a youth organization, so a
leaked name is a child's name. Before EVERY commit, scan the full diff
(`git diff --cached`) for the items below; if any appear, fix them BEFORE
committing — never plan to "clean it up later," and treat anything that
slipped into an earlier commit as an incident that requires a history
rewrite, not just a follow-up commit.

Never commit, in any file (code, tests, docs, fixtures, comments, commit
messages, screenshots):

- Real names of troop members, trailmen, parents/guardians, or leaders —
  test fixtures use invented names, never names from the real roster
- Phone numbers, email addresses, home addresses, birthdates (test phones
  are 555-xxxx; test emails end in @example.com)
- Trail Life Connect identifiers that belong to a person or a person's
  record: trailman hashids (`u` + 11 chars), advancement record ids
  (`ad` + 10 chars), service record ids, role hashids, member numbers,
  troop numbers. Docs and fixtures use `<trailmanHashid>` / `<adHashid>`
  placeholders.
  Award ids (`ac…`), level ids and event-type ids (`et…`) describe the Trail
  Life PROGRAM, not a person, and may be committed — they are the point of
  `lib/program.js`.
- Real roster counts, real event titles, or anything else that profiles the
  troop; keep examples generic
- Credentials of any kind: passwords, password hashes, session ids, tokens,
  cookies, API keys, .env values — mock creds must be self-evidently fake
  ("fake-password-never-real")
- Anything under `data/` (the database, backups, captured HTML) — the
  .gitignore fences it; never weaken it. A captured profile page contains a
  trailman hashid and record ids by construction.

Troop-identifying references (troop number, deployment domain, church name)
stay out of new code and docs — this codebase is troop-agnostic; branding
belongs in env/config on the deployment, not in the source.

## Trail Life Connect is READ-ONLY from this repo — with one audited exception

`lib/tlc.js` enforces an allow-list before any request leaves the process.
Reads that are permitted:

- `GET /login`, `POST /login`, `GET /logout` (only in direct-credential mode)
- `GET /advancement/index` (page shell: `#trailmen-select`, `#badge-select`)
- `POST /advancement/badge-tracker-view` (HTML fragment; read-only)
- `GET /profile/<trailmanHashid>` (`?tab=advancement` / `?tab=service`,
  `&page=N`) — the service ledger and the awards grid
- `GET /activities` — the troop-wide ledger

`POST /advancement/index` (the Standard-view save) is the **one** write this
project makes, and it lives in exactly one audited place:
`server/lib/starspush.js`, reached only through `lib/tlc.js`'s
`postAdvancementIndex` — which is deliberately **not** in the read-only
allow-list, so `request()` still refuses a write everywhere else. It ships
behind the `push_enabled` setting (default off), is admin-only ("Push now")
or scheduled while the flag is on, never retries an unconfirmed save, and
proves every save by read-back. Do not widen this: no other module may write.

These endpoints are NEVER called, whatever the method — they change data:
`/fields/toggleServiceActive` (a GET that flips a service-hours approval),
`/advancement/delete`, `/advancement/process-advancement`, and any
`/fields/*-update` route. `FORBIDDEN_PATH_RE` in `lib/tlc.js` blocks them.

Auth failures are terminal: exit immediately, never retry in a loop (TLC may
lock the account). Throttle every request (~300 ms).

## Two TLC read traps that silently corrupt the math

1. **The service ledger hard-caps at 100 rows and renders no pager.** Its
   footer row (`Total Servant Service Records: N`) is the checksum. Page with
   `?tab=service&page=N` until the row count matches N — `per-page` is
   ignored. A partial read undercounts hours and silently suppresses stars,
   so `ledger.complete === false` must refuse to propose, never guess.
2. A trailman with no service records still renders one placeholder row.
   Never count a row whose level and hours are unreadable.

Read the service ledger ONLY. It is the union of event-derived rows and
manual "Act of Service" rows; also summing the activities grid double-counts.

## Star policy (troop ruling — see docs/service-stars.md)

- Navigator Service Star = 15 h · Adventurer Service Star = 20 h.
- Fox, Hawk and Mountain Lion (Woodlands Trail) hours NEVER count toward a
  star and NEVER carry forward. Navigator's carry-in is always 0.
- Navigator leftover hours DO carry forward into Adventurer.
- APPROVED (verified) hours only — never unverified rows.
- More stars on record than the hours explain is a conflict for a leader,
  never a silent revert, except for the per-trailman baseline captured at
  first sync.

## Housekeeping

- `npm test` must pass before any push (Node's built-in runner; tests run
  against synthetic fixtures only — never a live site)
- No runtime dependencies without a reason; Node 20 has `fetch` and `crypto`
  (passwords use built-in scrypt — do not add a hashing dependency)
- DB changes go through numbered files in `server/migrations/` — never edit
  an applied migration
- Deployment is a human-triggered session on the Pi — never ship anything
  that changes runtime behaviour silently (features ship behind admin
  switches, off by default)

# Service Stars: the rules, and what the portal actually does

This is the reference for why the arithmetic is what it is, and for the two
places Trail Life Connect will quietly hand you wrong numbers if you let it.

## The troop's rules

| Level | Hours per star |
| --- | --- |
| Navigator | 15 |
| Adventurer | 20 |

1. **Woodlands Trail hours never count.** Fox, Hawk and Mountain Lion service
   is real service, but it earns no star and carries nothing forward.
   Navigator's carry-in is therefore always zero.
2. **Navigator leftovers carry forward into Adventurer.** A trailman who ends
   Navigators with 1 unused hour starts Adventurers with 1 hour toward his
   first Adventurer star.
3. **Verified hours only.** An unverified row is invisible to the arithmetic
   until a leader verifies it on the portal.
4. **Arithmetic-anchored, not incremental.** Every run recomputes the whole
   chain from the ledger, so proposals do not depend on the order things
   happened in, and a corrected hour figure corrects the stars.

### Worked example

A trailman with 29 verified Navigator hours and 82.5 verified Adventurer
hours, and nothing on the portal:

```
Navigator    29.00 counted + 0 carried in = 29.00 available
             29.00 / 15 = 1 star, 14.00 left over
Adventurer   82.50 counted + 14.00 carried in = 96.50 available
             96.50 / 20 = 4 stars, 16.50 left over
```

Five stars are owed: one Navigator and four Adventurer.

## Two portal behaviours that corrupt the numbers

### 1. The service ledger caps at 100 rows and renders no pager

The grid on `/profile/<trailmanHashid>?tab=service` shows at most 100 rows,
and — unlike every other grid on the site — draws no pagination control. A
reader that takes the page at face value simply loses everything past the
hundredth record. In this troop, three trailmen were already over the cap at
first look, one of them with 172 records.

What saves you is the grid's own footer:

```
Total Servant Service Records: 172        219
```

That count is the checksum. `?tab=service&page=2` **does** work even though no
pager is drawn (`per-page` is ignored), so the read follows `page=N` until the
rows it has match the declared count. If it cannot get there, the ledger is
marked incomplete and **no stars are proposed for that trailman** — an
undercount suppresses stars silently, which is the one failure nobody notices.

The footer's hour total is a second, independent check on the parse; a
disagreement is reported in the sync log.

### 2. The ledger and the activities grid overlap

The profile carries two grids with hours in them:

- the **activities** grid (`w1-container`), with a `Servant Service Hours`
  column on event rows, and
- the **service ledger** (`w10-container`), with `Act of Service` and
  `Time Spent`.

The ledger is the **union**: event-derived rows appear in it with the same
record ids as the activities grid, alongside hand-entered service records.
Reading both double-counts every event. Only the ledger is read.

## Other things worth knowing

- **Event Level is historical, not current.** A trailman who crossed over
  shows `Mountain Lion` on his 2023 rows and `Navigator` on his 2024 ones, so
  Woodlands hours can be excluded reliably.
- **A trailman with no service records still renders one row** — an empty
  placeholder. Counting it invents a phantom record.
- **The awards grid carries no award id.** Unlike the sibling platform, a
  Service Star instance is identified by its title (`Navigator Service Star`)
  and program, not by an `ac…` id. The row's `data-key` is
  `<adHashid>|<trailmanHashid>`.
- **There is no "Stars Eligible" table** on a Trail Life profile, so the
  portal offers no second opinion on the star count. The ledger totals are the
  only cross-check available.
- **The verified toggle is a GET that writes.** `/fields/toggleServiceActive/
  <recordId>?attribute=verified` flips approval. It is parsed for the record
  id and never followed; `FORBIDDEN_PATH_RE` in `lib/tlc.js` blocks it.

## Stars the hours don't explain

Paper records predate the portal, so a trailman can hold more stars than his
ledger accounts for. The first sync takes a **baseline** per trailman and
level — stars on record, stars the hours earned, and the hours available at
that moment — so those extras are absorbed rather than fought. A leader then
rules on what they were:

| Ruling | What it does |
| --- | --- |
| `separate` (default) | Extras are paper-era stars. They stack on top of what the hours earn; the next star needs a full allotment of new hours. |
| `woodlands` | Extras were awarded on Fox/Hawk/Mountain Lion hours before the troop excluded them. The stars stand and a **fixed** credit covers exactly what they needed at baseline. |
| `fresh` | Extras stand for some other reason and the level restarts at a date: only hours on or after it count, nothing carries in. |

The Woodlands credit is deliberately **fixed rather than shrinking**. A credit
that shrinks as new hours arrive means those new hours pay back the old star
instead of counting toward the next one, and the trailman appears to make no
progress. The credit is capped at the covered stars' worth and at his actual
Woodlands total, so counted hours dropping below the baseline still surfaces
as a conflict.

After the baseline exists, two things are conflicts a leader is shown:

- `more_on_record` — a star appeared that the hours do not explain;
- `instance_removed` — a star that was there at baseline has gone.

Neither is ever resolved by the app writing to the portal.

## Proposal lifecycle

A proposal is identified by trailman, level and **ordinal** ("his 4th
Navigator star"), which makes the whole cycle idempotent:

```
                 hours support it
      (none) ─────────────────────▶ proposed ──▶ approved ──▶ queued ──▶ recorded
                                       │  ▲          │
                        leader says no │  │ reopen   │ push_enabled off:
                                       ▼  │          │ it just waits
                                    rejected         ▼
                                                  held (unconfirmed —
      hours no longer support it: withdrawn       a person looks)
```

- A **rejected** ordinal is never proposed again unless a leader reopens it.
- A star that turns up on the portal retires its proposal as `recorded`.
- A trailman whose ledger could not be read in full has his open proposals
  withdrawn with the reason, rather than left to look approved-worthy.

## Writing a star back: what the save actually needs

Adding one instance is a full-form POST, and the two endpoints involved do
NOT share a vocabulary. Both sets below were captured from the live page.

`POST /advancement/badge-tracker-view` — read the panels:

    _csrf, level, style, trailmen[], badges, lockedChecked,
    event_id, track_attendance

Send the *form's* field names here instead and the portal answers
`This action can only be used in AJAX mode.` in a 42-byte body.

`POST /advancement/index` — the save:

    _csrf, style-select, level-select, trailmen-select[], badge-select,
    date-specified, lock-checked, show-completed-checked,
    show-items-checked, comment-specified, track-attendance,
    event-attendance          …plus every award panel field

**The fragment is panels only** — no `<form>`, no `_csrf`, none of the page's
own controls (~54 KB of panel markup and nothing else). So the body is the
page form *plus* the fragment's panels: build it from the fragment alone and
nine fields the portal always sends go missing, and a field left out of this
form is a field cleared.

Three more things the markup will mislead you about:

- `level-select` and `style-select` are **radios**, and their values are short
  codes — `wt` | `navadv`, and `standard` | `grid` | `summary`. They are not
  the level hashids used everywhere else on the site.
- `lock-checked`, `show-completed-checked`, `show-items-checked` and
  `track-attendance` look like checkboxes but are Krajee checkbox-x **text**
  inputs carrying `"0"`/`"1"`, so they are always submitted. So is
  `purchased-<adId>`, and so are the readonly datepicker inputs.
- An instance already on the record has **no `new-` input at all**. Only an
  empty slot carries one, set to `"true"`.

Proof of a save is a read-back, never the response: the instance count for
that level must rise by exactly one, the new instance must carry our date and
comment, and every instance that was already there must be byte-identical.
Anything else holds the row for a person — a blind retry is how a duplicate
star gets created.

## Program ids

These describe the Trail Life program rather than any person, so they live in
`lib/program.js` and in git.

| Thing | Id |
| --- | --- |
| Navigator Service Star | `acc66f374e08` |
| Adventurer Service Star | `acb527dc22b8` |
| Fox | `l3c59dc048e8` |
| Hawk | `ib6d767d2f8e` |
| Mountain Lion | `k37693cfc748` |
| Navigator | `j8e296a067a3` |
| Adventurer | `x1ff1de77400` |

The Navigator and Adventurer ids double as the "All Navigators" / "All
Adventurers" group options in the advancement page's trailman picker.

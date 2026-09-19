-- 001-init.sql — the whole schema.
--
-- Everything a trailman's row holds comes from Trail Life Connect, so every
-- table here is a CACHE plus the troop's own decisions on top of it. Names
-- and hashids live only in this database; they never reach a log or git.

-- Arbitrary key/value config an admin can change at runtime (push_enabled,
-- last sync state). JSON in `value`; `updated_by` is a user e-mail.
CREATE TABLE IF NOT EXISTS setting (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT,
  updated_by  TEXT
);

-- Encrypted blobs that are not settings: the TLC cookie jar and any parked
-- sign-in challenge. Kept apart from `setting` so nothing ever renders one
-- into a settings page by accident.
CREATE TABLE IF NOT EXISTS vault (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT
);

-- ---------------------------------------------------------------- people ---
-- Leaders who may sign in. Passwords are scrypt hashes (server/lib/auth.js);
-- `must_change` forces a new password on the next sign-in after an admin
-- sets one. `disabled_at` keeps the audit trail instead of deleting a row.
CREATE TABLE IF NOT EXISTS app_user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'leader' CHECK (role IN ('leader', 'admin')),
  password_hash TEXT,
  must_change   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  last_login_at TEXT,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  disabled_at   TEXT
);

-- Server-side sessions: the cookie holds only a random id, so signing a
-- leader out is a DELETE and a stolen cookie dies with the row.
CREATE TABLE IF NOT EXISTS session (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  last_seen_at TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_expires ON session(expires_at);

-- -------------------------------------------------------------- trailmen ---
-- One row per trailman seen in TLC's #trailmen-select. `active` goes to 0
-- when a sync stops seeing him — his history stays.
CREATE TABLE IF NOT EXISTS trailman (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tlc_user_id  TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- The mirrored service ledger: one row per TLC service record, per trailman.
-- `hundredths` is integer hundredths of an hour — never a float.
CREATE TABLE IF NOT EXISTS service_row (
  trailman_id  INTEGER NOT NULL REFERENCES trailman(id) ON DELETE CASCADE,
  record_id    TEXT NOT NULL,
  date         TEXT,
  description  TEXT,
  hundredths   INTEGER,
  level        TEXT,
  verified     INTEGER,
  seen_at      TEXT NOT NULL,
  PRIMARY KEY (trailman_id, record_id)
);
CREATE INDEX IF NOT EXISTS idx_service_trailman ON service_row(trailman_id);

-- The mirrored awards grid, limited to Service Star instances. One row per
-- instance; `ad_id` is TLC's advancement record id.
CREATE TABLE IF NOT EXISTS star_instance (
  trailman_id  INTEGER NOT NULL REFERENCES trailman(id) ON DELETE CASCADE,
  ad_id        TEXT NOT NULL,
  level        TEXT NOT NULL,
  completed_on TEXT,
  awarded_on   TEXT,
  purchased    INTEGER NOT NULL DEFAULT 0,
  seen_at      TEXT NOT NULL,
  PRIMARY KEY (trailman_id, ad_id)
);
CREATE INDEX IF NOT EXISTS idx_star_trailman ON star_instance(trailman_id);

-- The per-trailman, per-level snapshot taken at first sync, plus the leader's
-- ruling about any stars the hours do not explain. Without this, a paper-era
-- star reads as a permanent conflict (see lib/stars.js).
--   legacy_mode 'separate' (default) — extras stack on what the hours earn
--               'woodlands'          — extras were paid for by Fox/Hawk/ML
--                                      hours; a FIXED credit covers them
--               'fresh'              — extras stand; the level restarts at
--                                      fresh_from
CREATE TABLE IF NOT EXISTS star_baseline (
  trailman_id  INTEGER NOT NULL REFERENCES trailman(id) ON DELETE CASCADE,
  level        TEXT NOT NULL,
  on_record    INTEGER NOT NULL,
  earnable     INTEGER NOT NULL,
  hundredths   INTEGER NOT NULL,
  legacy_mode  TEXT NOT NULL DEFAULT 'separate'
               CHECK (legacy_mode IN ('separate', 'woodlands', 'fresh')),
  fresh_from   TEXT,
  captured_at  TEXT NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT,
  PRIMARY KEY (trailman_id, level)
);

-- ------------------------------------------------------------- proposals ---
-- A star the arithmetic says is owed. `ordinal` is which star of that level
-- it is (1 = his first), so a rejected star is never proposed again and an
-- approval is idempotent across syncs.
CREATE TABLE IF NOT EXISTS proposal (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trailman_id  INTEGER NOT NULL REFERENCES trailman(id) ON DELETE CASCADE,
  level        TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'proposed'
               CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn', 'recorded')),
  hundredths_at_proposal INTEGER,
  completed_on TEXT,
  proposed_at  TEXT NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT,
  note         TEXT,
  UNIQUE (trailman_id, level, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_proposal_status ON proposal(status);

-- The push queue. One row per star to write to TLC. `state` never goes back
-- to 'queued' by itself: an unconfirmed save is 'held' for a human, never
-- retried, because a blind retry is how you create a duplicate star.
CREATE TABLE IF NOT EXISTS push_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id  INTEGER NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  trailman_id  INTEGER NOT NULL REFERENCES trailman(id) ON DELETE CASCADE,
  level        TEXT NOT NULL,
  completed_on TEXT NOT NULL,
  comment      TEXT,
  state        TEXT NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued', 'sent', 'confirmed', 'held', 'failed', 'cancelled')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  queued_at    TEXT NOT NULL,
  queued_by    TEXT,
  sent_at      TEXT,
  confirmed_at TEXT,
  ad_id        TEXT,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_state ON push_queue(state);

-- ----------------------------------------------------------------- runs ----
-- One row per sync or push run: what ran, how it went, what it warned about.
CREATE TABLE IF NOT EXISTS run (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (kind IN ('sync', 'push')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  ok           INTEGER,
  trigger      TEXT,
  actor        TEXT,
  summary      TEXT,
  warnings     TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_kind ON run(kind, started_at);

-- Who changed what. Every decision a leader makes lands here.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  before     TEXT,
  after      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

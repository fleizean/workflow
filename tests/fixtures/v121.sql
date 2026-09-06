-- v1.2.1 schema fixture - the MIGRATION PATH, not a tidied rewrite.
--
-- This is the canonical of the two schema sources named by D-05. The other is
-- tests/fixtures/v121-real-schema.sql, extracted from the owner's real krono.db by plan 01-04.
-- tests/backup.test.ts diffs the sqlite_master produced by this file against that extract,
-- byte for byte, on every run.
--
-- WHY THE ALTER STATEMENTS ARE STILL HERE, rather than folded into the CREATE bodies:
--
-- sqlite_master stores each CREATE statement as it was typed. When database/db.js appended
-- company_id, note, excel_column, note_column and note_required with ALTER TABLE, SQLite
-- rewrote the stored text by splicing them in after the closing column - leaving a visible
-- textual scar:
--
--       updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
--     , excel_column TEXT, note_column TEXT, note_required INTEGER DEFAULT 0);
--
-- A fixture built from flat CREATE TABLEs would be semantically identical and textually
-- different. It would diff against the real extract and read as a SECOND LEGACY VARIANT that
-- does not exist in the wild, sending Phase 4's DATA-04 adoption logic after a ghost. Plan
-- 01-04 flagged this explicitly and this file honours it: run the migrations, do not
-- pre-collapse them.
--
-- Two further properties this file must preserve, both load-bearing:
--
-- 1. COLUMN ORDER. The ALTER-appended columns sit LAST. Phase 4 reads the schema with
--    PRAGMA table_info; a tidier order would pass a test that every real database fails.
-- 2. NO foreign-key pragma of any kind. database/db.js issues none, so this file issues none.
--
--    CB-4 concludes from that silence that the declared ON DELETE CASCADE is inert. IT IS NOT.
--    better-sqlite3 compiles SQLite with SQLITE_DEFAULT_FOREIGN_KEYS=1 (deps/defines.gypi), so
--    enforcement is ON from the moment a connection opens, with or without a pragma - measured
--    in the driver this repo now uses and in the 9.x build config bundled inside the shipped
--    v1.2.1 asar. The cascade is LIVE for every user.
--
--    This file must therefore stay silent on the subject, so that a fixture opened through the
--    driver behaves exactly as a real database does. See tests/fixtures/seed.ts's
--    makeOrphanFixture for what that means for Phase 4's DATA-12.
--
-- A third object appears without being written anywhere: sqlite_sequence. SQLite creates it
-- implicitly for AUTOINCREMENT tables, so a fixture has FIVE sqlite_master rows, not four,
-- even with zero rows inserted. It appears in no DDL in database/db.js. Plan 01-04 found it in
-- the real database and Phase 4's migration runner must expect it.
--
-- NOT IDEMPOTENT, deliberately. The CREATEs guard with IF NOT EXISTS but the ALTERs do not,
-- so running this twice against one database raises "duplicate column name". Every fixture is
-- built into a fresh temporary directory, and a second application would mean a bug worth
-- hearing about rather than silently absorbing.
--
-- Transcribed from database/db.js:23-129 (initDatabase), whitespace included. The indentation
-- is not style - it is stored verbatim in sqlite_master and is part of the byte-for-byte match.

CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

CREATE TABLE IF NOT EXISTS work_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

-- database/db.js:44-56 - the work_sessions migrations.
ALTER TABLE work_sessions ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE work_sessions ADD COLUMN note TEXT;

-- database/db.js:58-73 - the companies migrations.
ALTER TABLE companies ADD COLUMN excel_column TEXT;
ALTER TABLE companies ADD COLUMN note_column TEXT;
ALTER TABLE companies ADD COLUMN note_required INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      company_id INTEGER,
      pomodoros_completed INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

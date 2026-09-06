/*
 * tests/fixtures/seed-child.cjs
 *
 * Builds the ONE fixture that cannot be built in-process: a database whose -wal sidecar is
 * non-empty on disk, holding committed rows the main file does not contain.
 *
 * This process is forked by tests/fixtures/seed.ts and then SIGKILLed. That is not incidental
 * and it is not tidy-able. sqlite3_close on the last connection CHECKPOINTS AND DELETES the
 * -wal, so any fixture that ends with a clean db.close() - including one that merely lets the
 * process exit normally - hands back a single-file database with no sidecar at all. Plan
 * 01-08's negative control would then pass forever without ever being able to fail, and
 * CUSTODY-03 would be "proven" by a test with no teeth.
 *
 * The same mechanism is why the owner's real krono.db-wal is 0 bytes: their app was closed
 * cleanly. The user this fixture speaks for is the one whose app was killed from the tray.
 *
 * CommonJS on purpose - it is launched by a plain child_process.fork, with no transform step
 * in front of it.
 *
 * Every step below is load-bearing. Skipping any one of them yields a fixture that still looks
 * fine and quietly proves nothing:
 *
 *   journal_mode = WAL          without it there is no -wal to be non-empty
 *   wal_autocheckpoint = 0      without it SQLite checkpoints at 1000 pages and the sidecar's
 *                               contents become a function of row count rather than of intent
 *   checkpoint(TRUNCATE) first  without it "rows in the main file" and "rows in the sidecar"
 *                               cannot be told apart, so the negative control measures nothing
 *   SIGKILL, never close()      see above - a clean close deletes the evidence
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

/*
 * The row split IS the recipe, so it lives with the recipe. tests/backup.test.ts deliberately
 * restates these numbers instead of importing them: a test that imported the split could only
 * ever prove the generator agrees with itself.
 *
 * 5 rows of 3600s are checkpointed into the main database file; 40 rows of 100s are committed
 * afterwards and never checkpointed, so they exist only in the sidecar. A backup that captures
 * the main file alone therefore loses 40 of 45 sessions and 4000 of 22000 seconds - a loss
 * large enough that no rounding or off-by-one could explain it away.
 */
const CHECKPOINTED_ROWS = 5;
const CHECKPOINTED_DURATION = 3600;
const WAL_ONLY_ROWS = 40;
const WAL_ONLY_DURATION = 100;

const dbPath = process.argv[2];
if (!dbPath) {
    throw new Error('seed-child.cjs: expected a database path as argv[2]');
}

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('wal_autocheckpoint = 0');

// Normalised to LF so the stored sqlite_master text is identical whatever a checkout did to
// the file. tests/fixtures/*.sql is pinned to eol=lf in .gitattributes; this is the belt to
// that braces, and it is what keeps the D-05 byte-for-byte comparison honest on any machine.
db.exec(fs.readFileSync(path.join(__dirname, 'v121.sql'), 'utf8').replace(/\r\n/g, '\n'));

const insertCompany = db.prepare(
    'INSERT INTO companies (name, created_at, updated_at, note_required) VALUES (?, ?, ?, ?)'
);
insertCompany.run('Unassigned', '2026-01-01 09:00:00', '2026-01-01 09:00:00', 0);
insertCompany.run('Northwind Fixture', '2026-01-01 09:00:00', '2026-01-01 09:00:00', 1);

// created_at is always passed explicitly. DEFAULT CURRENT_TIMESTAMP would make the fixture's
// content differ between runs and turn every content-based assertion into a flake.
const insertSession = db.prepare(
    'INSERT INTO work_sessions (name, duration, date, company_id, note, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?)'
);

// Phase A - written, then forced into the MAIN database file.
for (let i = 0; i < CHECKPOINTED_ROWS; i++) {
    insertSession.run(
        'checkpointed-' + i,
        CHECKPOINTED_DURATION,
        '2026-01-0' + (i + 1),
        1,
        'Fixture task: checkpointed ' + i,
        '2026-01-01 09:00:00'
    );
}
db.pragma('wal_checkpoint(TRUNCATE)');

// Phase B - committed, and then deliberately abandoned in the sidecar. Each statement
// autocommits, so these rows are durable as far as SQLite is concerned; they are simply not in
// the file a naive copy would take.
for (let i = 0; i < WAL_ONLY_ROWS; i++) {
    insertSession.run(
        'wal-only-' + i,
        WAL_ONLY_DURATION,
        '2026-02-01',
        2,
        'Fixture task: wal-only ' + i,
        '2026-02-01 09:00:00'
    );
}

// Report what we built before handing control back, so a parent that finds an empty sidecar can
// say whether the writes happened at all or whether something checkpointed them away.
const walPath = dbPath + '-wal';
const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;

if (typeof process.send !== 'function') {
    throw new Error('seed-child.cjs: not running under fork() - no IPC channel to signal on');
}
process.send({ ready: true, walSize: walSize });

// Stay alive, holding the connection open, until the parent kills us. Returning from here would
// let the event loop drain, close the database and checkpoint the sidecar away.
setInterval(() => {}, 1000);

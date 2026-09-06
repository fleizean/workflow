/*
 * tests/fixtures/seed.ts
 *
 * The CUSTODY-06 fixture corpus. GENERATED, never captured (D-04).
 *
 * No database file is ever committed, and none is ever written into the working tree: every
 * fixture is built into a fresh mkdtemp directory at test time. That is a privacy boundary
 * before it is a hygiene preference - the only real v1.2.1 database in existence belongs to the
 * owner and contains real client names and real work notes (D-03). .gitignore excludes the
 * three database patterns, tests/custody-hygiene.test.ts asserts none is tracked, and
 * verify.yml fails the build on a tracked one. This file is why none of those ever has to fire:
 * there is nothing to commit by accident.
 *
 * Four shapes, one per failure mode the next plans have to survive:
 *
 *   makeCleanFixture()   representative rows, checkpointed - the ordinary case
 *   makeWalFixture()     a NON-EMPTY -wal holding committed rows the main file lacks
 *   makeEmptyFixture()   schema, zero rows - proves sum() coalesces rather than returning NULL
 *   makeOrphanFixture()  work_sessions pointing at a company that no longer exists
 *
 * Only makeWalFixture needs a subprocess, and it needs one absolutely: see seed-child.cjs.
 */

import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V121_SQL = path.join(HERE, 'v121.sql');
const SEED_CHILD = path.join(HERE, 'seed-child.cjs');

/* Every directory this module created, so a test run leaves nothing behind in the temp dir. */
const created: string[] = [];

function freshDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-' + tag + '-'));
    created.push(dir);
    return dir;
}

export function cleanupFixtures(): void {
    while (created.length > 0) {
        const dir = created.pop();
        if (dir === undefined) continue;
        // Best effort: on Windows a lingering handle can hold a file briefly, and failing a
        // green test run over temp-directory housekeeping would be its own kind of bug.
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            /* leave it to the OS */
        }
    }
}

/*
 * The v1.2.1 DDL, LF-normalised. .gitattributes pins tests/fixtures/*.sql to eol=lf, so on a
 * correct checkout this changes nothing; it exists so that a checkout which somehow produced
 * CRLF cannot alter the text SQLite stores in sqlite_master and thereby break the D-05
 * byte-for-byte comparison for a reason that has nothing to do with the schema.
 */
export function readV121Ddl(): string {
    return fs.readFileSync(V121_SQL, 'utf8').replace(/\r\n/g, '\n');
}

/*
 * Renders a database's schema in exactly the format tools/baseline/archive-real-db.mjs used to
 * write tests/fixtures/v121-real-schema.sql from the owner's real database, so the two can be
 * compared as bytes rather than interpreted. Reads nothing but type, name and sql.
 */
export function schemaOf(dbPath: string): string {
    const db = new Database(dbPath, { readonly: true });
    try {
        const rows = db
            .prepare<[], { type: string; name: string; sql: string }>(
                'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name'
            )
            .all();
        return rows.map((row) => String(row.sql).replace(/\s+$/, '') + ';').join('\n\n') + '\n';
    } finally {
        db.close();
    }
}

/*
 * The invariant that stops a degraded fixture from passing silently.
 *
 * Called by makeWalFixture before it hands anything back, and exercised directly by
 * tests/backup.test.ts against a fixture degraded the way it degrades in real life - by a clean
 * close. It THROWS rather than returning a boolean because the only correct response to "the
 * sidecar is empty" is to stop: a caller that could ignore the answer would.
 */
export function assertWalNonEmpty(dbPath: string): number {
    const walPath = dbPath + '-wal';
    if (!fs.existsSync(walPath)) {
        throw new Error(
            'fixture invariant violated: ' + walPath + ' does not exist. A clean close ' +
            'checkpoints and deletes the sidecar - the fixture was closed rather than killed.'
        );
    }
    const size = fs.statSync(walPath).size;
    if (size === 0) {
        throw new Error(
            'fixture invariant violated: ' + walPath + ' is 0 bytes. Every committed row is in ' +
            'the main database file, so a file-copy backup would capture all of them and the ' +
            'CUSTODY-03 negative control would pass without being able to fail.'
        );
    }
    return size;
}

/*
 * Copies the WHOLE triple - database, -wal and -shm - into a fresh directory.
 *
 * Pitfall 2, and the reason this helper is not optional: opening the pristine fixture
 * read-write checkpoints its sidecar away, so the NEXT test finds a single-file database and
 * its negative control passes for the wrong reason. Every case works on a copy.
 */
export function copyFixture(dbPath: string): string {
    const srcDir = path.dirname(dbPath);
    const dstDir = freshDir('case');
    for (const entry of fs.readdirSync(srcDir)) {
        /*
         * eslint-disable-next-line no-restricted-syntax --
         * CUSTODY-03 forbids fs.copyFileSync on a database because a copy of a LIVE database
         * silently omits whatever is in its -wal. Sanctioned here, and only here in the test
         * corpus, for two reasons that both have to hold: the source is a fixture no process
         * holds open (seed-child.cjs has already been killed and reaped), and the loop copies
         * EVERY file in the directory - the .db, the -wal and the -shm together - so nothing
         * can be left behind. Copying the triple is a faithful move; copying the .db alone is
         * the bug the rule exists to catch, and tests/backup.test.ts builds that broken case
         * deliberately by DELETING sidecars from a full copy rather than by making a partial one.
         */
        // eslint-disable-next-line no-restricted-syntax
        fs.copyFileSync(path.join(srcDir, entry), path.join(dstDir, entry));
    }
    return path.join(dstDir, path.basename(dbPath));
}

/* Applies the v1.2.1 migration path to a new database in a fresh directory. */
function newFixture(tag: string): { db: Database.Database; dbPath: string } {
    const dbPath = path.join(freshDir(tag), 'krono.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // database/db.js:12 does this on every real database
    db.exec(readV121Ddl());
    return { db, dbPath };
}

/*
 * Deterministic synthetic rows. Every created_at is explicit: DEFAULT CURRENT_TIMESTAMP would
 * make the fixture's content differ between runs, and a content assertion over it would flake.
 * Every name is obviously synthetic, so a fixture can never be mistaken for real data.
 */
function seedRepresentativeRows(db: Database.Database): void {
    const insertCompany = db.prepare(
        'INSERT INTO companies (name, created_at, updated_at, excel_column, note_required) ' +
        'VALUES (?, ?, ?, ?, ?)'
    );
    insertCompany.run('Unassigned', '2026-01-01 09:00:00', '2026-01-01 09:00:00', null, 0);
    insertCompany.run('Northwind Fixture', '2026-01-01 09:00:00', '2026-01-01 09:00:00', 'B', 1);
    insertCompany.run('Contoso Fixture', '2026-01-02 09:00:00', '2026-01-02 09:00:00', 'C', 0);

    const insertSession = db.prepare(
        'INSERT INTO work_sessions (name, duration, date, company_id, note, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
    );
    const sessions: [string, number, string, number, string][] = [
        ['Morning block', 14400, '2026-01-05', 2, 'Fixture task: morning block'],
        ['Afternoon block', 5400, '2026-01-05', 2, 'Fixture task: afternoon block'],
        ['Review', 10800, '2026-01-06', 3, 'Fixture task: review'],
        ['Unassigned work', 1800, '2026-01-07', 1, 'Fixture task: unassigned work']
    ];
    for (const [name, duration, date, companyId, note] of sessions) {
        insertSession.run(name, duration, date, companyId, note, '2026-01-05 09:00:00');
    }

    const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    insertSetting.run('daily_target', '28800');
    insertSetting.run('pomodoro_enabled', 'false');
}

/*
 * The ordinary case: rows, checkpointed, sidecar gone. Closing cleanly is the RIGHT thing here
 * and the WRONG thing for the WAL fixture - which is the whole distinction the corpus exists to
 * draw.
 */
export function makeCleanFixture(): string {
    const { db, dbPath } = newFixture('clean');
    seedRepresentativeRows(db);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close(); // checkpoints and removes the sidecar - deliberate
    return dbPath;
}

/*
 * A fresh install with the schema and nothing in it. This is what proves that a daily total is
 * computed with COALESCE(sum(duration), 0): bare sum() over no rows returns NULL, and a total
 * that renders as "null" on day one is the cheapest possible way to lose a new user's trust
 * (DATA-05).
 */
export function makeEmptyFixture(): string {
    const { db, dbPath } = newFixture('empty');
    db.close();
    return dbPath;
}

/*
 * work_sessions pointing at a company id that no longer resolves.
 *
 * READ THIS BEFORE CHANGING IT - the research premise behind this fixture is WRONG, and the
 * correction is what makes the construction below look odd.
 *
 * CB-4 states that database/db.js never issues PRAGMA foreign_keys, so the declared ON DELETE
 * CASCADE is inert in every real user's database. The first half is true; the conclusion is
 * not. better-sqlite3 does not need db.js to enable foreign keys, because it compiles SQLite
 * with SQLITE_DEFAULT_FOREIGN_KEYS=1 (deps/defines.gypi) - so enforcement is ON from the moment
 * the connection opens. Verified in the driver this repo now uses AND in the 9.x build config
 * bundled inside the shipped v1.2.1 asar, so it was true for every release users are running.
 *
 * Consequences, stated plainly because Phase 4's DATA-12 depends on getting this right:
 *
 *  - The cascade is LIVE. Deleting a company really does delete its work_sessions.
 *  - That is not silent data loss. database/db.js:303-312 deletes the sessions EXPLICITLY first
 *    and does not lean on the cascade at all, and companies.html warns the user with the exact
 *    session count before proceeding. The behaviour is intended and disclosed.
 *  - So the normal delete path CANNOT produce an orphan: both the explicit DELETE and the
 *    cascade remove the rows.
 *
 * The fixture is still worth having, because foreign_keys is a PER-CONNECTION pragma. Anything
 * that opens krono.db without the driver's default - the sqlite3 CLI, DB Browser for SQLite, a
 * hand-rolled repair script, a partial restore - can delete a company and leave its sessions
 * behind. Phase 4's cleanup is therefore DEFENSIVE, aimed at databases a third-party tool has
 * touched, not at a population the app itself creates. That distinction changes how DATA-12
 * should be sized and messaged, so it is recorded here rather than in a commit message.
 *
 * Hence the explicit PRAGMA below: this state now has to be MANUFACTURED. It no longer falls
 * out of the app's own behaviour, and pretending otherwise would be the "reconciled away"
 * failure that plan 01-07's D-05 truth warns about.
 */
export function makeOrphanFixture(): string {
    const { db, dbPath } = newFixture('orphan');
    seedRepresentativeRows(db);

    // Exactly what an external tool does: enforcement off for this connection, then delete.
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM companies WHERE name = ?').run('Contoso Fixture');
    db.pragma('foreign_keys = ON');

    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    return dbPath;
}

/*
 * The fixture this entire plan exists to make possible: committed rows living in the -wal
 * sidecar and nowhere else.
 *
 * The fork is the mechanism, not decoration. There is no way to produce this in-process,
 * because every route out of this function that does not end in a killed process ends in a
 * clean close, and a clean close checkpoints the sidecar and deletes it. See seed-child.cjs.
 */
export function makeWalFixture(): Promise<string> {
    const dbPath = path.join(freshDir('wal'), 'krono.db');

    return new Promise<string>((resolve, reject) => {
        const child = fork(SEED_CHILD, [dbPath], {
            stdio: ['ignore', 'ignore', 'inherit', 'ipc']
        });
        let signalled = false;

        child.on('message', () => {
            signalled = true;
            child.kill('SIGKILL'); // never close() - that would checkpoint the evidence away
        });

        child.on('error', reject);

        child.on('exit', (code, signal) => {
            if (!signalled) {
                // The child died before it finished writing. Say so plainly: the alternative is
                // a confusing "-wal is empty" further down that blames the invariant rather
                // than the crash that caused it.
                reject(
                    new Error(
                        'seed-child.cjs exited before signalling ready (code ' + String(code) +
                        ', signal ' + String(signal) + '). The WAL fixture was not built.'
                    )
                );
                return;
            }
            try {
                assertWalNonEmpty(dbPath);
                resolve(dbPath);
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });
}

/*
 * tests/backup.test.ts
 *
 * Plan 01-07 creates this file with the FIXTURE-INVARIANT block only. Plan 01-08 adds the
 * backup and restore blocks to this same file, which is what binds the validation strategy's
 * per-requirement commands to real tests.
 *
 * Why the invariants live here rather than beside the generator: the fixture corpus is not an
 * incidental test helper, it is the evidence. CUSTODY-03's whole proof - that fs.copyFileSync
 * is not a backup and db.backup() is - is vacuous unless one fixture holds committed rows that
 * its main database file does not contain. A fixture whose -wal is silently empty passes that
 * proof forever without ever being able to fail it. So the fixture's own properties are asserted
 * first, in the same file as the thing they underwrite.
 *
 * The owner's own machine is the cautionary example: their krono.db-wal is 0 bytes, because the
 * app was closed cleanly. A naive file-copy backup tests green against that database and loses
 * data for a user whose app was killed from the tray.
 */

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
    assertWalNonEmpty,
    cleanupFixtures,
    copyFixture,
    makeCleanFixture,
    makeEmptyFixture,
    makeOrphanFixture,
    makeWalFixture,
    readV121Ddl,
    schemaOf
} from './fixtures/seed';

afterAll(() => {
    cleanupFixtures();
});

const REAL_SCHEMA = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'v121-real-schema.sql'
);

/*
 * The WAL fixture's row split, RESTATED here rather than imported from the generator.
 *
 * Importing the constants would make the assertion tautological - it would only prove the
 * generator agrees with itself. These numbers are the contract: 5 rows checkpointed into the
 * main file, 40 committed into the sidecar and never checkpointed. If someone narrows that
 * split the fixture stops being adversarial, and this test is what has to notice.
 */
const CHECKPOINTED_ROWS = 5;
const CHECKPOINTED_SECONDS = 5 * 3600;
const WAL_ONLY_ROWS = 40;
const WAL_ONLY_SECONDS = 40 * 100;

/*
 * Reads a scalar out of a fixture. The typings default Result to unknown, so the row shape is
 * declared at the call site rather than asserted away with `any`.
 *
 * The missing-column guard is not defensive padding. A bare `row?.v ?? 0` returns 0 for any
 * query whose result column is not aliased `v` - which is every PRAGMA, since a PRAGMA names
 * its column after itself. An assertion built on that reads 0 whatever the database contains,
 * so it passes forever and can never fail. This file shipped exactly one such assertion (see
 * the foreign-key case below). Fail loudly instead of quietly.
 */
function scalar(dbPath: string, sql: string): number {
    const db = new Database(dbPath);
    try {
        const row = db.prepare<[], { v: number | null }>(sql).get();
        if (row === undefined || !('v' in row)) {
            throw new Error(
                'scalar(): the query returned no column aliased `v`, so its value would have ' +
                'read as 0 whatever the database contained. Alias the column. Query: ' + sql
            );
        }
        // A genuine SQL NULL still reads as 0; COALESCE where that distinction matters.
        return row.v ?? 0;
    } finally {
        db.close();
    }
}

/*
 * Closes a database the way the application does: open it, USE it, close it.
 *
 * The "use it" step is load-bearing, and its absence was a real defect in this file's first
 * draft. `new Database(x).close()` does NOT checkpoint, because SQLite opens the database file
 * lazily - a connection that never reads has never opened the -wal, so closing it has nothing
 * to check point and the sidecar survives untouched. Measured on better-sqlite3 13.0.3:
 * open-then-close leaves the -wal in place; open-read-close deletes it.
 *
 * That matters twice over. It is the difference between a degradation test that exercises the
 * real failure mode and one that asserts nothing at all, and it is a genuine hazard for plan
 * 01-08's restore path: opening a database is not the same as touching one.
 */
function closeCleanlyLikeTheApp(dbPath: string): void {
    const db = new Database(dbPath);
    try {
        db.prepare<[], { v: number }>('SELECT count(*) v FROM work_sessions').get();
    } finally {
        db.close();
    }
}

function columnsOf(dbPath: string, table: string): string[] {
    const db = new Database(dbPath);
    try {
        return db
            .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
            .all()
            .map((c) => c.name);
    } finally {
        db.close();
    }
}

describe('the v1.2.1 fixture schema', () => {
    /*
     * D-05. Plan 01-04 extracted the owner's real sqlite_master and concluded it matches
     * database/db.js. This asserts that conclusion mechanically and permanently, against the
     * fixture that is actually used, rather than trusting a comparison made once by hand.
     *
     * The comparison is byte-for-byte on purpose. sqlite_master stores the CREATE statement as
     * it was typed, so an ALTER-appended column leaves a textual scar - CURRENT_TIMESTAMP,
     * newline, then ", excel_column TEXT, ...". A fixture built from flat CREATE TABLEs would be
     * semantically identical and textually different, and would therefore read as a second
     * legacy variant that does not exist. That is why v121.sql runs the migration path.
     */
    it("reproduces the owner's real sqlite_master byte for byte (D-05)", () => {
        const realFile = fs.readFileSync(REAL_SCHEMA, 'utf8').replace(/\r\n/g, '\n');
        const realBody = realFile.slice(realFile.indexOf('CREATE TABLE'));
        expect(schemaOf(makeEmptyFixture())).toBe(realBody);
    });

    /*
     * The real database contains sqlite_sequence, created implicitly by AUTOINCREMENT, and it
     * appears in no DDL anywhere in database/db.js. Plan 01-04 flagged it explicitly. Phase 4's
     * migration runner must expect five objects in sqlite_master, not four.
     */
    it('contains the five objects a real v1.2.1 database has, sqlite_sequence included', () => {
        const names = schemaOf(makeEmptyFixture())
            .split('\n')
            .filter((line) => line.startsWith('CREATE TABLE'))
            .map((line) => line.replace(/^CREATE TABLE (\w+).*$/, '$1'));
        expect(names).toEqual([
            'companies',
            'pomodoro_sessions',
            'settings',
            'sqlite_sequence',
            'work_sessions'
        ]);
    });

    /*
     * Column ORDER is load-bearing, not cosmetic: Phase 4 reads the schema with PRAGMA
     * table_info. In a real v1.2.1 database these columns were appended by ALTER TABLE and sit
     * last. A tidier fixture would pass a test that the real database fails.
     */
    it('keeps the ALTER-appended columns last, as a real v1.2.1 database has them', () => {
        const fx = makeEmptyFixture();
        expect(columnsOf(fx, 'work_sessions')).toEqual([
            'id', 'name', 'duration', 'date', 'created_at', 'company_id', 'note'
        ]);
        expect(columnsOf(fx, 'companies')).toEqual([
            'id', 'name', 'created_at', 'updated_at', 'excel_column', 'note_column', 'note_required'
        ]);
    });

    /*
     * CB-4 says: database/db.js never issues PRAGMA foreign_keys, therefore every declared
     * ON DELETE CASCADE is inert in every real user's database. The premise is true. THE
     * CONCLUSION IS FALSE, and this is where that gets nailed down rather than repeated.
     *
     * better-sqlite3 compiles SQLite with SQLITE_DEFAULT_FOREIGN_KEYS (confirmed in this
     * driver's own PRAGMA compile_options), so enforcement is ON from the moment the driver
     * opens a connection - pragma or no pragma. The cascade is LIVE for every user: deleting a
     * company really does delete its work_sessions. That is not silent data loss;
     * database/db.js:303-312 deletes the sessions explicitly first and companies.html warns with
     * the exact session count, so the behaviour is intended and disclosed. But Phase 4's DATA-12
     * must be sized as DEFENSIVE cleanup after third-party tools, not as cleanup of a population
     * the application itself produces.
     *
     * The fixture's job is therefore to stay SILENT on the subject, exactly as database/db.js
     * is, so that a fixture opened through the driver behaves as a real database does.
     *
     * The assertion this replaces read `scalar(fx, 'PRAGMA foreign_keys')` and expected 0. It
     * passed - but a PRAGMA names its result column after itself, so scalar() found no column
     * aliased `v` and returned its fallback. It asserted nothing whatsoever, and it asserted it
     * about a claim that is false. scalar() now throws on that shape.
     */
    it('issues no foreign-key pragma, and is therefore opened with the cascades LIVE', () => {
        expect(readV121Ddl()).not.toMatch(/PRAGMA\s+foreign_keys/i);

        const db = new Database(makeEmptyFixture());
        try {
            expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
        } finally {
            db.close();
        }
    });

    it('enforces ON DELETE CASCADE, contrary to CB-4', () => {
        const fx = makeCleanFixture();
        const sessionsOf = (id: number): number =>
            scalar(fx, 'SELECT count(*) v FROM work_sessions WHERE company_id = ' + String(id));

        expect(sessionsOf(2)).toBeGreaterThan(0);

        const db = new Database(fx);
        try {
            db.prepare('DELETE FROM companies WHERE id = 2').run();
        } finally {
            db.close();
        }
        // No explicit session delete was issued. Were the cascade inert, these would survive.
        expect(sessionsOf(2)).toBe(0);
    });
});

describe('the WAL fixture', () => {
    /*
     * The one assertion this whole plan exists to make possible. Selectable by name:
     *   npx vitest run tests/backup.test.ts -t 'non-empty -wal'
     */
    it('has a non-empty -wal sidecar on disk when a test opens it', async () => {
        const fx = await makeWalFixture();
        expect(fs.existsSync(fx + '-wal')).toBe(true);
        const size = fs.statSync(fx + '-wal').size;
        expect(size).toBeGreaterThan(0);
        // Not merely a header: a bare WAL header is 32 bytes and holds no committed frame.
        expect(size).toBeGreaterThan(32);
    });

    /*
     * The property plan 01-08's negative control depends on. The main file alone is exactly what
     * a naive fs.copyFileSync backup captures; the sidecar holds rows it never sees. Asserted as
     * exact counts rather than as an inequality, because an inequality would still hold if the
     * split drifted to 44/1 and the fixture quietly stopped being adversarial.
     */
    it('holds committed rows that the main database file alone does not contain', async () => {
        const fx = await makeWalFixture();

        const whole = copyFixture(fx);
        const mainOnly = copyFixture(fx);
        // Exactly what a file copy that grabbed only krono.db leaves behind.
        fs.rmSync(mainOnly + '-wal', { force: true });
        fs.rmSync(mainOnly + '-shm', { force: true });

        const countAll = 'SELECT count(*) v FROM work_sessions';
        const sumAll = 'SELECT coalesce(sum(duration), 0) v FROM work_sessions';

        expect(scalar(whole, countAll)).toBe(CHECKPOINTED_ROWS + WAL_ONLY_ROWS);
        expect(scalar(mainOnly, countAll)).toBe(CHECKPOINTED_ROWS);
        expect(scalar(whole, countAll)).toBeGreaterThan(scalar(mainOnly, countAll));

        expect(scalar(whole, sumAll)).toBe(CHECKPOINTED_SECONDS + WAL_ONLY_SECONDS);
        expect(scalar(mainOnly, sumAll)).toBe(CHECKPOINTED_SECONDS);
    });

    /*
     * The invariant must be able to fail, and it must fail on the real degradation mode rather
     * than on a made-up one. A clean close checkpoints and deletes the -wal - that is exactly how
     * a well-meaning fixture ends up silently empty, and it is why the owner's own krono.db-wal
     * is 0 bytes. So: degrade a COPY by closing it cleanly, then point the generator's own guard
     * at it.
     */
    it('throws instead of returning a fixture whose -wal is empty', async () => {
        const fx = await makeWalFixture();
        const degraded = copyFixture(fx);

        expect(assertWalNonEmpty(degraded)).toBeGreaterThan(0);

        // Reads before closing, deliberately: see closeCleanlyLikeTheApp. A bare
        // `new Database(degraded).close()` never touches the file and leaves the -wal intact,
        // so this test would fail while the invariant it exercises was perfectly healthy.
        closeCleanlyLikeTheApp(degraded); // checkpoints and removes the sidecar
        expect(fs.existsSync(degraded + '-wal')).toBe(false);

        expect(() => assertWalNonEmpty(degraded)).toThrow(/fixture invariant violated/);
        // The pristine fixture is untouched by any of this.
        expect(assertWalNonEmpty(fx)).toBeGreaterThan(0);
    });
});

describe('the rest of the fixture corpus', () => {
    it('leaves the clean fixture checkpointed, with every row in the main file', () => {
        const fx = makeCleanFixture();
        const sidecar = fx + '-wal';
        expect(!fs.existsSync(sidecar) || fs.statSync(sidecar).size === 0).toBe(true);

        const total = scalar(fx, 'SELECT count(*) v FROM work_sessions');
        expect(total).toBeGreaterThan(0);
        expect(scalar(copyFixture(fx), 'SELECT count(*) v FROM work_sessions')).toBe(total);
    });

    /*
     * DATA-05. sum() over no rows is NULL, not 0, and a daily total that renders as "NaN" or
     * "null" on a fresh install is the cheapest possible way to make a new user distrust the app.
     */
    it('sums duration to zero rather than null on the empty fresh-install fixture', () => {
        const fx = makeEmptyFixture();
        expect(scalar(fx, 'SELECT count(*) v FROM work_sessions')).toBe(0);
        expect(scalar(fx, 'SELECT count(*) v FROM companies')).toBe(0);
        expect(scalar(fx, 'SELECT coalesce(sum(duration), 0) v FROM work_sessions')).toBe(0);

        const db = new Database(fx);
        try {
            const bare = db
                .prepare<[], { v: number | null }>('SELECT sum(duration) v FROM work_sessions')
                .get();
            expect(bare?.v).toBeNull(); // the trap COALESCE exists to close
        } finally {
            db.close();
        }
    });

    /*
     * DATA-12. These rows exist in the wild precisely because the cascades are inert (CB-4):
     * deleting a company in v1.2.1 leaves its sessions behind, pointing at nothing.
     */
    it('carries work_sessions orphaned while the cascades were inert', () => {
        const fx = makeOrphanFixture();
        const orphans = scalar(
            fx,
            'SELECT count(*) v FROM work_sessions w ' +
                'WHERE w.company_id IS NOT NULL ' +
                'AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = w.company_id)'
        );
        expect(orphans).toBeGreaterThan(0);
        expect(scalar(fx, 'SELECT count(*) v FROM work_sessions')).toBeGreaterThan(orphans);
    });
});

describe('fixture handling', () => {
    /*
     * Pitfall 2. Opening the pristine fixture read-write checkpoints its sidecar away, and the
     * NEXT test then runs against a single-file database and passes for the wrong reason. Every
     * case must work on a copy of the whole triple.
     */
    it('copies the whole triple and leaves the pristine fixture untouched', async () => {
        const fx = await makeWalFixture();
        const before = fs.statSync(fx + '-wal').size;

        const copy = copyFixture(fx);
        expect(path.dirname(copy)).not.toBe(path.dirname(fx));
        for (const suffix of ['', '-wal', '-shm']) {
            expect(fs.existsSync(copy + suffix)).toBe(true);
        }
        expect(fs.statSync(copy + '-wal').size).toBe(before);

        // Mutate the copy as destructively as a test can - a clean close checkpoints its entire
        // sidecar away - then re-check the original. closeCleanlyLikeTheApp rather than a bare
        // open-and-close, which touches nothing: this assertion would otherwise hold without the
        // copy ever having been mutated, and would prove the isolation it claims to prove by
        // accident.
        closeCleanlyLikeTheApp(copy);
        expect(fs.existsSync(copy + '-wal')).toBe(false);
        expect(fs.statSync(fx + '-wal').size).toBe(before);
    });

    /*
     * Every created_at is passed explicitly; DEFAULT CURRENT_TIMESTAMP would make fixture content
     * differ between runs and turn any content-based assertion into a flake.
     */
    it('generates identical row content on two runs', () => {
        const dump = (dbPath: string): string => {
            const db = new Database(dbPath);
            try {
                return JSON.stringify([
                    db.prepare<[], unknown>('SELECT * FROM companies ORDER BY id').all(),
                    db.prepare<[], unknown>('SELECT * FROM work_sessions ORDER BY id').all(),
                    db.prepare<[], unknown>('SELECT * FROM settings ORDER BY key').all()
                ]);
            } finally {
                db.close();
            }
        };
        expect(dump(makeCleanFixture())).toBe(dump(makeCleanFixture()));
        expect(dump(makeOrphanFixture())).toBe(dump(makeOrphanFixture()));
    });
});

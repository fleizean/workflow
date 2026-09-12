// Fixture invariants first (the backup proofs are vacuous without them), then the backup module contract and the
// CUSTODY-03/04/05 blocks, whose titles the validation strategy's -t filters select on.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
    DEFAULT_RETAINED_BACKUPS,
    backupDatabase,
    describeVerificationMismatches,
    pruneBackups,
    readDatabaseStats,
    restoreDatabase,
    verifyBackup
} from '../src/lib/db/backup';
import type { BackupVerification } from '../src/lib/db/backup';

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
import { buildLegacyFixture, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
import { instantFromEpochMs } from '@shared/utils/date';

function at(h: number, m: number, s: number): Date {
    return instantFromEpochMs(Date.UTC(2026, 8, 6, h, m, s));
}

afterAll(() => {
    cleanupFixtures();
    cleanupLegacyFixtures();
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
     * DATA-12. These rows are NOT what the application produces, and the fixture does not claim
     * they are. The cascades are live - see "enforces ON DELETE CASCADE, contrary to CB-4" above -
     * and database/db.js deletes the sessions explicitly before removing a company anyway, so the
     * app's own delete path cannot strand one. The owner's real database holds 97 sessions and 0
     * orphans.
     *
     * The fixture is kept because it is DEFENSIVE, not descriptive. foreign_keys is a
     * per-connection pragma, so anything that opens krono.db without better-sqlite3's compiled-in
     * default - the sqlite3 CLI, DB Browser for SQLite, a hand-rolled repair script, a partial
     * restore - can delete a company and leave its sessions pointing at nothing. Phase 4's cleanup
     * has to survive that database whoever made it. So makeOrphanFixture() manufactures the state
     * with an explicit PRAGMA, exactly as such a tool would; tests/fixtures/seed.ts records the
     * correction and its consequences for DATA-12 at length.
     */
    it('carries work_sessions orphaned by a tool that opened the database without foreign keys', () => {
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

/*
 * Reads a database's true row count and summed duration WITHOUT disturbing it.
 *
 * readonly:true is the whole point and is not interchangeable with scalar() above. A read-write
 * connection that reads and then closes CHECKPOINTS - it folds the -wal into the main file and
 * deletes the sidecar. Calling scalar() on a WAL fixture before taking the naive copy would
 * therefore hand the naive copy every row, and CUSTODY-03's negative control would pass while
 * proving the opposite of what it claims. Measured in plan 01-07: open-read-close removes the
 * sidecar; a read-only connection leaves it byte-for-byte intact.
 */
function truth(dbPath: string): { count: number; sum: number } {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const row = db
            .prepare<[], { c: number; s: number }>(
                'SELECT count(*) c, coalesce(sum(duration), 0) s FROM work_sessions'
            )
            .get();
        if (row === undefined) {
            throw new Error('truth(): aggregate query returned no row for ' + dbPath);
        }
        return { count: row.c, sum: row.s };
    } finally {
        db.close();
    }
}

/* Byte identity, for asserting that a refused operation really wrote nothing. */
function sha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function backupDirFor(dbPath: string): string {
    return path.join(path.dirname(dbPath), 'backups');
}

/*
 * Plan 01-08, Task 1 - the module's own contract, separate from the three requirement blocks.
 *
 * These are the properties that make the requirement proofs below possible at all: a destination
 * that cannot collide, a refusal to touch one that already exists, a source connection that does
 * not consume what it reads, and a deadline that can end a backup which will not end by itself.
 */
describe('src/lib/db/backup.ts module contract', () => {
    it('produces a verified copy matching the source on rows and summed duration', async () => {
        const fx = makeCleanFixture();
        const before = truth(fx);
        expect(before.count).toBeGreaterThan(0);

        const result = await backupDatabase(fx, backupDirFor(fx));

        expect(result.verification.integrity).toBe('ok');
        expect(result.verification.rows.work_sessions).toBe(before.count);
        expect(result.verification.totalDuration).toBe(before.sum);
        expect(result.totalPages).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupPath)).toBe(true);
    });

    /*
     * DATA-05's null trap, at the module boundary rather than in SQL. sum() over zero rows is
     * NULL, and `NULL !== 0` would fail a fresh-install backup for no reason at all - on the one
     * database where a spurious "backup failed" is most likely to be believed.
     */
    it('verifies an empty fresh-install database with a summed duration of zero, not null', async () => {
        const fx = makeEmptyFixture();
        const result = await backupDatabase(fx, backupDirFor(fx));

        expect(result.verification.totalDuration).toBe(0);
        expect(result.verification.rows.work_sessions).toBe(0);
        expect(result.verification.rows.companies).toBe(0);
        expect(result.verification.rows.pomodoro_sessions).toBe(0);
        expect(result.verification.integrity).toBe('ok');
    });

    /*
     * The backup on disk must be ONE file. The online backup API closes and checkpoints its own
     * destination handle, but verifying the result reopens it, and a read-only connection cannot
     * delete the -shm and empty -wal that reopening a WAL database creates. Left in place they
     * are not untidiness: restoreDatabase copies the .bak alone, so a sidecar beside a backup is
     * content a restore would silently not carry, and it outlives the .bak once that backup is
     * pruned. Discovered by execution here, not by reading - the research note that the
     * destination "is a single quiescent file" is true of the backup call and not of the
     * verification that must follow it.
     */
    it('leaves the backup as a single quiescent file with no sidecars beside it', async () => {
        const fx = makeCleanFixture();
        const dir = backupDirFor(fx);

        const result = await backupDatabase(fx, dir);

        expect(fs.readdirSync(dir)).toEqual([path.basename(result.backupPath)]);
        for (const suffix of ['-wal', '-shm']) {
            expect(fs.existsSync(result.backupPath + suffix)).toBe(false);
        }
    });

    it('reopens a backup read-only and reports integrity, per-table counts and summed duration', async () => {
        const fx = makeCleanFixture();
        const { backupPath } = await backupDatabase(fx, backupDirFor(fx));

        const verification = verifyBackup(backupPath);
        expect(verification.integrity).toBe('ok');
        expect(Object.keys(verification.rows).sort()).toEqual([
            'companies',
            'pomodoro_sessions',
            'settings',
            'work_sessions'
        ]);
        expect(verification).toEqual(readDatabaseStats(fx));
    });

    /*
     * A stable krono.db.bak is the trap this avoids: the driver opens an existing destination
     * SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE and overwrites it silently, so a second failed
     * migration attempt would destroy the good copy the first one made.
     */
    it('derives a distinct timestamped destination from the injected clock', async () => {
        const fx = makeCleanFixture();
        const dir = backupDirFor(fx);

        const first = await backupDatabase(fx, dir, { now: at(10, 0, 0) });
        const second = await backupDatabase(fx, dir, { now: at(10, 0, 1) });

        expect(path.basename(first.backupPath)).toBe('krono.db.2026-09-06T10-00-00-000Z.bak');
        expect(first.backupPath).not.toBe(second.backupPath);
        expect(fs.readdirSync(dir)).toHaveLength(2);
    });

    it('refuses a destination that already exists and leaves it byte-identical', async () => {
        const fx = makeCleanFixture();
        const dir = backupDirFor(fx);
        const now = at(10, 0, 0);

        const first = await backupDatabase(fx, dir, { now });
        const digestBefore = sha256(first.backupPath);

        await expect(backupDatabase(fx, dir, { now })).rejects.toThrow(/already exists/);
        expect(sha256(first.backupPath)).toBe(digestBefore);
        expect(fs.readdirSync(dir)).toHaveLength(1);
    });

    /*
     * WR-04: the sweep runs at the top of every backup, before the source is opened. force: true suppresses
     * ENOENT only, so a leftover that will not delete - held by a scanner, left read-only by a restore tool, or a
     * directory a user made with that name - threw out of backupDatabase, which the runner turns into "No backup
     * was taken" and a refused migration. Identically, on every launch. A directory is the portable stand-in: rmSync
     * without recursive refuses it on Windows and POSIX alike.
     */
    it('completes when a leftover staging file in backups/ cannot be deleted', async () => {
        const fx = makeCleanFixture();
        const dir = backupDirFor(fx);
        fs.mkdirSync(dir, { recursive: true });
        const stubborn = path.join(dir, path.basename(fx) + '.2020-01-01T00-00-00-000Z.bak.partial');
        fs.mkdirSync(stubborn);
        fs.writeFileSync(path.join(stubborn, 'held'), 'a scanner has this open');

        const result = await backupDatabase(fx, dir, { now: at(10, 0, 0) });

        expect(result.verification.integrity).toBe('ok');
        expect(fs.existsSync(result.backupPath), 'the backup the migration depends on was not written').toBe(true);
        expect(fs.existsSync(stubborn), 'the leftover was deleted, so the sweep never hit it').toBe(true);
    });

    /*
     * Pitfall 2 at the module level. readonly:true backs up the FULL sidecar content and leaves
     * the source's -wal in place, so a fixture is not consumed by being backed up. A read-write
     * source connection would checkpoint on close and quietly disarm every later case.
     */
    it('leaves the source -wal intact, because the source is opened read-only', async () => {
        const fx = await makeWalFixture();
        const working = copyFixture(fx);
        const sidecarBefore = fs.statSync(working + '-wal').size;
        expect(sidecarBefore).toBeGreaterThan(0);

        await backupDatabase(working, backupDirFor(working));

        expect(fs.statSync(working + '-wal').size).toBe(sidecarBefore);
        expect(assertWalNonEmpty(fx)).toBeGreaterThan(0);
    });

    /*
     * better-sqlite3 does not sleep on SQLITE_BUSY and SQLite may restart a backup indefinitely
     * while the source is being written, so an unbounded backup could in principle never finish.
     * Phase 4 runs this immediately before a migration, where hanging is the worst outcome.
     *
     * A zero deadline makes the abort deterministic: the driver's first transfer(0) is a probe
     * that copies no pages, so the progress callback is always invoked at least once.
     */
    it('aborts a backup that exceeds its wall-clock deadline and leaves no partial file', async () => {
        const fx = makeCleanFixture();
        const dir = backupDirFor(fx);
        const now = at(10, 0, 0);

        await expect(backupDatabase(fx, dir, { now, deadlineMs: 0 })).rejects.toThrow(/deadline/i);

        // The destination did not exist beforehand, so the driver unlinks the partial file.
        expect(fs.existsSync(path.join(dir, 'krono.db.2026-09-06T10-00-00-000Z.bak'))).toBe(false);
    });

    /*
     * A -wal describing a database that no longer exists is the classic separated-WAL hazard,
     * and a restore creates exactly that state unless the target's sidecars go first. The WAL
     * fixture is the only source that makes this observable: its target carries a 329 KB sidecar
     * full of frames that describe the PRE-restore file. Against a clean fixture there would be
     * no sidecar to leave behind and the assertion would pass without the removal existing.
     */
    it('removes the stale sidecars of the database it restores over', async () => {
        const fx = await makeWalFixture();
        const target = copyFixture(fx);
        const { backupPath } = await backupDatabase(target, backupDirFor(target));

        const staleFrames = fs.statSync(target + '-wal').size;
        expect(staleFrames).toBeGreaterThan(32);

        const restored = restoreDatabase(backupPath, target);

        expect(restored.integrity).toBe('ok');
        expect(restored.rows.work_sessions).toBe(CHECKPOINTED_ROWS + WAL_ONLY_ROWS);
        const survivingFrames = fs.existsSync(target + '-wal')
            ? fs.statSync(target + '-wal').size
            : 0;
        expect(survivingFrames).toBe(0);
    });

    /*
     * A retention count of zero is not an instruction to delete the only backup there is. The
     * newest is the one a migration is about to depend on.
     */
    it('never deletes the newest backup, whatever retention count it is given', async () => {
        const fx = makeCleanFixture();
        const dir = backupDirFor(fx);
        const newest = await backupDatabase(fx, dir, { now: at(10, 0, 2) });
        await backupDatabase(fx, dir, { now: at(10, 0, 0) });

        expect(DEFAULT_RETAINED_BACKUPS).toBe(3);
        for (const keep of [0, -1]) {
            pruneBackups(dir, keep);
            expect(fs.existsSync(newest.backupPath)).toBe(true);
        }
        expect(fs.readdirSync(dir)).toHaveLength(1);
    });
});

/*
 * CUSTODY-03. Selected by the validation strategy's name filter:
 *   npx vitest run tests/backup.test.ts -t 'uncheckpointed'
 *
 * The argument this block makes is not "the online backup works". It is that the OBVIOUS
 * alternative fails silently, so nothing short of the online backup is acceptable. That is why
 * the naive copy is executed here as a real negative control rather than described in a comment:
 * on a cleanly-closed database the two approaches are indistinguishable, which is exactly why
 * the owner's own krono.db-wal is 0 bytes and why a naive backup would have tested green on this
 * machine forever.
 */
describe('CUSTODY-03: the online backup captures uncheckpointed WAL content', () => {
    it('keeps rows a file copy loses, and that copy still reports integrity ok', async () => {
        const fx = await makeWalFixture();
        const pristineSidecar = fs.statSync(fx + '-wal').size;

        // Never the pristine fixture, always a copy of the whole triple (Pitfall 2). truth() is
        // read-only, so reading the ground truth does not checkpoint the evidence away.
        const source = copyFixture(fx);
        const expected = truth(source);
        expect(expected.count).toBe(CHECKPOINTED_ROWS + WAL_ONLY_ROWS);
        expect(expected.sum).toBe(CHECKPOINTED_SECONDS + WAL_ONLY_SECONDS);

        /*
         * THE NEGATIVE CONTROL. Copying the main database file is what a backup written by
         * someone who has not read sqlite.org/backup.html looks like.
         *
         * eslint-disable-next-line no-restricted-syntax -- this call is the DEFECT under test.
         * The CUSTODY-03 rule exists to stop exactly this from reaching production code; here it
         * is executed deliberately so its consequence is measured rather than asserted.
         */
        const naiveCase = copyFixture(fx);
        const naive = path.join(path.dirname(naiveCase), 'naive-copy.bak');
        // eslint-disable-next-line no-restricted-syntax
        fs.copyFileSync(naiveCase, naive);
        const naiveStats = truth(naive);

        /*
         * STRICTLY less, never less-than-or-equal. A fixture that had degraded to a clean
         * single file would satisfy the weaker comparison, and this test would pass while
         * proving the exact opposite of what it claims.
         */
        expect(naiveStats.count).toBeLessThan(expected.count);
        expect(naiveStats.sum).toBeLessThan(expected.sum);
        expect(naiveStats.count).toBe(CHECKPOINTED_ROWS);
        expect(naiveStats.sum).toBe(CHECKPOINTED_SECONDS);

        // ...and it is NOT corrupt. Nothing throws, nothing warns. The bad backup is not
        // broken, it is short - which is the entire reason integrity_check is insufficient.
        expect(verifyBackup(naive).integrity).toBe('ok');

        // THE REAL THING, against the same fixture, in the same test.
        const result = await backupDatabase(source, backupDirFor(source));
        expect(result.verification.integrity).toBe('ok');
        expect(result.verification.rows.work_sessions).toBe(expected.count);
        expect(result.verification.totalDuration).toBe(expected.sum);

        // Everything above ran read-only against copies; the pristine fixture is untouched, so
        // the next test in this file still finds an adversarial sidecar.
        expect(fs.statSync(fx + '-wal').size).toBe(pristineSidecar);
        expect(fs.statSync(source + '-wal').size).toBeGreaterThan(32);
    });
});

/*
 * CUSTODY-04. A backup nobody checked is a belief, and a backup checked only against itself is
 * a belief with a certificate.
 */
describe('CUSTODY-04: a backup is verified against the source, not against itself', () => {
    /*
     * The naive copy's REAL measured statistics, run through the module's own comparison. This
     * is the pairing the requirement turns on: the copy passes every check it can perform on
     * itself, and fails the only check that compares it with what it was copied from.
     */
    it('rejects the naive copy on rows and on summed duration, though it passes integrity', async () => {
        const fx = await makeWalFixture();
        const source = copyFixture(fx);
        const sourceStats = readDatabaseStats(source);

        const naiveCase = copyFixture(fx);
        const naive = path.join(path.dirname(naiveCase), 'naive-copy.bak');
        // eslint-disable-next-line no-restricted-syntax -- deliberate negative control, see above
        fs.copyFileSync(naiveCase, naive);
        const naiveStats = readDatabaseStats(naive);

        // What a verification that stopped at integrity would conclude:
        expect(naiveStats.integrity).toBe('ok');

        // What the module concludes instead.
        const mismatches = describeVerificationMismatches(sourceStats, naiveStats);
        expect(mismatches).toHaveLength(2);
        expect(mismatches[0]).toContain('work_sessions');
        expect(mismatches[0]).toContain(String(CHECKPOINTED_ROWS));
        expect(mismatches[0]).toContain(String(CHECKPOINTED_ROWS + WAL_ONLY_ROWS));
        expect(mismatches[1]).toContain(String(WAL_ONLY_SECONDS));
        expect(mismatches[1]).toContain('seconds of tracked time');

        // A copy that IS complete produces nothing to report.
        const good = await backupDatabase(source, backupDirFor(source));
        expect(describeVerificationMismatches(sourceStats, good.verification)).toEqual([]);
    });

    /*
     * The comparison firing end-to-end, on real files, with no mocking and no mutation.
     *
     * restoreDatabase is handed a LIVE WAL-mode database in place of a quiesced backup. It reads
     * 45 sessions from it (main file plus sidecar), then copies the main file alone - which is
     * precisely the naive-copy defect - and the re-verification catches the 40 missing rows and
     * refuses. This is also why restoreDatabase re-verifies at all: a file copy is only sound
     * against a backup the online API produced, and this proves what happens when it is not.
     */
    it('refuses to accept a short copy, naming the table and both values', async () => {
        const fx = await makeWalFixture();
        const notAQuiescedBackup = copyFixture(fx);
        const target = makeCleanFixture();

        expect(() => restoreDatabase(notAQuiescedBackup, target)).toThrow(
            /Restore verification failed[\s\S]*work_sessions[\s\S]*sum\(duration\)/
        );
    });

    /*
     * The error must name the mismatch. "Backup failed" is useless at three in the morning
     * during a migration, which is the only time anyone reads it.
     */
    it('states expected against observed rather than merely that something went wrong', async () => {
        const fx = await makeWalFixture();
        const notAQuiescedBackup = copyFixture(fx);
        const target = makeCleanFixture();

        let message = '';
        try {
            restoreDatabase(notAQuiescedBackup, target);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain('holds ' + String(CHECKPOINTED_ROWS) + ' rows');
        expect(message).toContain('expected ' + String(CHECKPOINTED_ROWS + WAL_ONLY_ROWS));
        expect(message).toContain(String(WAL_ONLY_SECONDS) + ' seconds of tracked time');
        // T-01-37: counts and sums only. No row value, company name or session note.
        expect(message).not.toMatch(/Northwind|Contoso|Fixture task/);
    });
});

/*
 * CUSTODY-05. Selected by the validation strategy's name filter:
 *   npx vitest run tests/backup.test.ts -t 'restore'
 *
 * A backup with no tested restore is untested code on the most important path in the
 * application.
 */
describe('CUSTODY-05: restore returns a damaged database to service', () => {
    it('refuses to restore a backup that is not a database, and leaves the target alone', async () => {
        const fx = makeCleanFixture();
        const { backupPath } = await backupDatabase(fx, backupDirFor(fx));
        const targetDigestBefore = sha256(fx);

        fs.writeFileSync(backupPath, Buffer.alloc(4096, 0x41));

        expect(() => restoreDatabase(backupPath, fx)).toThrow(
            /Refusing to restore an unverified backup/
        );
        // Refused BEFORE touching the target: the working database is byte-identical, and its
        // sidecars were not removed either.
        expect(sha256(fx)).toBe(targetDigestBefore);
        expect(truth(fx).count).toBeGreaterThan(0);
    });

    /*
     * The round trip, on the WAL fixture rather than the clean one, so three things are true at
     * once: the backup had to capture sidecar content to be complete, the damaged target still
     * carries a 329 KB stale sidecar describing the file that was destroyed, and the recovered
     * statistics are compared against values measured before the damage rather than against
     * constants.
     */
    // WR-03: the copy used to go straight over the target, after its sidecars had already been deleted, so a
    // refused or interrupted restore left the target truncated with no way back.
    it('leaves every row of the target in place when it refuses a short copy', async () => {
        const fx = await makeWalFixture();
        const notAQuiescedBackup = copyFixture(fx);
        const target = await makeWalFixture();
        const before = readDatabaseStats(target);
        expect(before.rows.work_sessions, 'the target holds no uncheckpointed rows, so this proves nothing')
            .toBe(CHECKPOINTED_ROWS + WAL_ONLY_ROWS);

        expect(() => restoreDatabase(notAQuiescedBackup, target)).toThrow(/Restore verification failed/);

        const after = readDatabaseStats(target);
        expect(after.rows.work_sessions, 'a refused restore took rows out of the target it never replaced')
            .toBe(before.rows.work_sessions);
        expect(after.totalDuration, 'a refused restore cost the target tracked time').toBe(before.totalDuration);
        expect(fs.existsSync(target + '.incoming'), 'a refused restore left its staging file behind').toBe(false);
    });

    /*
     * WR-01: the target's sidecars were deleted before the rename that replaces it, so a rename that failed -
     * EPERM/EBUSY from a scanner, an indexer or a stale handle is ordinary on Windows - left the main file in
     * place with its uncheckpointed rows gone. The WAL fixture holds 40 of its 45 sessions in that sidecar, so
     * the cost is measurable rather than theoretical. Only the incoming -> target rename is made to fail; the
     * put-back renames must still work, which is the behaviour under test.
     */
    it('leaves every row of the target in place when the rename over it fails', async () => {
        const source = await makeWalFixture();
        const target = await makeWalFixture();
        const { backupPath } = await backupDatabase(source, backupDirFor(source));
        const before = truth(target);
        expect(before.count, 'the target holds no uncheckpointed rows, so this proves nothing')
            .toBe(CHECKPOINTED_ROWS + WAL_ONLY_ROWS);
        expect(fs.statSync(target + '-wal').size, 'the target carries no -wal, so there is nothing to lose')
            .toBeGreaterThan(0);

        const realRename = fs.renameSync.bind(fs);
        const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
            if (String(from) === target + '.incoming') {
                throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
            }
            realRename(from, to);
        });
        try {
            expect(() => restoreDatabase(backupPath, target)).toThrow(/EPERM/);
        } finally {
            spy.mockRestore();
        }

        const after = truth(target);
        expect(after.count, 'a failed rename took rows out of the target it never replaced').toBe(before.count);
        expect(after.sum, 'a failed rename cost the target tracked time').toBe(before.sum);
        expect(fs.existsSync(target + '.incoming'), 'a failed restore left its staging file behind').toBe(false);
        expect(fs.existsSync(target + '.replaced'), 'a failed restore left the target displaced').toBe(false);
    });

    /*
     * WR-04: removePendingBackup of the displaced copy ran inside the outer try, after the rename that ends the
     * restore. The displaced file is the user's old database and its -wal - exactly what a scanner holds open on
     * Windows - so an undeletable one turned a restore that had already succeeded into a thrown failure, with
     * <target>.replaced left on disk and a caller told to try the procedure again against the restored file.
     */
    it('reports a restore that already succeeded as a success, even if the displaced copy will not delete', async () => {
        const fx = await makeWalFixture();
        const live = copyFixture(fx);
        const before = truth(live);
        expect(before.count, 'the fixture lost its uncheckpointed rows, so this proves nothing')
            .toBe(CHECKPOINTED_ROWS + WAL_ONLY_ROWS);

        const { backupPath } = await backupDatabase(live, backupDirFor(live));
        fs.writeFileSync(live, Buffer.alloc(4096, 0x41));
        expect(() => truth(live), 'the target is still readable, so the restore proves nothing').toThrow(/not a database/);

        const displaced = live + '.replaced';
        const realRm = fs.rmSync.bind(fs);
        const spy = vi.spyOn(fs, 'rmSync').mockImplementation((target: fs.PathLike, options?: fs.RmOptions) => {
            if (String(target) === displaced) {
                throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
            }
            realRm(target, options);
        });
        let recovered: BackupVerification;
        try {
            recovered = restoreDatabase(backupPath, live);
        } finally {
            spy.mockRestore();
        }

        expect(recovered.integrity).toBe('ok');
        expect(truth(live), 'the restore that was reported did not put the rows back').toEqual(before);
        expect(fs.existsSync(displaced), 'the displaced copy was deletable after all, so this proves nothing')
            .toBe(true);
    });

    it('damages a working database, restores it, and recovers the exact pre-damage figures', async () => {
        const fx = await makeWalFixture();
        const live = copyFixture(fx);
        const before = truth(live);
        expect(before.count).toBe(CHECKPOINTED_ROWS + WAL_ONLY_ROWS);

        const { backupPath } = await backupDatabase(live, backupDirFor(live));

        // DAMAGE. Overwrite the main file's header and pages with non-database bytes, and leave
        // the sidecar in place - that is what a half-written file or a bad restore looks like,
        // and a -wal describing a database that no longer exists is the hazard restore must
        // clear rather than inherit.
        const staleFrames = fs.statSync(live + '-wal').size;
        expect(staleFrames).toBeGreaterThan(32);
        fs.writeFileSync(live, Buffer.alloc(4096, 0x41));

        // Observed, not assumed: the database can no longer be opened at all.
        expect(() => truth(live)).toThrow(/not a database/);

        const recovered = restoreDatabase(backupPath, live);

        expect(recovered.integrity).toBe('ok');
        expect(recovered.rows.work_sessions).toBe(before.count);
        expect(recovered.totalDuration).toBe(before.sum);
        expect(truth(live)).toEqual(before);

        const survivingFrames = fs.existsSync(live + '-wal') ? fs.statSync(live + '-wal').size : 0;
        expect(survivingFrames).toBe(0);
    });
});

/*
 * Retention. Phase 4's DATA-03 asks for "old backups are pruned"; the count is a parameter so
 * that phase can set its own policy without editing the module.
 */
describe('backup retention', () => {
    it('keeps the three newest of five, deletes only the older two, and rewrites nothing', async () => {
        const fx = makeCleanFixture();
        const dir = backupDirFor(fx);

        // Created out of chronological order on purpose: a prune that trusted insertion order,
        // or directory order, would pass a test that made them in sequence.
        const order = ['10:00:03', '10:00:00', '10:00:04', '10:00:02', '10:00:01'];
        const byStamp = new Map<string, string>();
        for (const stamp of order) {
            const made = await backupDatabase(fx, dir, {
                now: at(10, 0, Number(stamp.slice(-2)))
            });
            byStamp.set(stamp, made.backupPath);
        }
        expect(fs.readdirSync(dir)).toHaveLength(5);

        const survivors = ['10:00:02', '10:00:03', '10:00:04'].map((s) => byStamp.get(s) ?? '');
        const digestsBefore = survivors.map(sha256);

        const swept = pruneBackups(dir, 3);

        expect(swept.deleted.sort()).toEqual([byStamp.get('10:00:00'), byStamp.get('10:00:01')].sort());
        expect(swept.skipped, 'the sweep could not finish on an ordinary directory').toEqual([]);
        expect(fs.readdirSync(dir)).toHaveLength(3);
        for (const survivor of survivors) {
            expect(fs.existsSync(survivor)).toBe(true);
        }
        // Pruning only deletes. It must never write over a known-good backup.
        expect(survivors.map(sha256)).toEqual(digestsBefore);
        // The newest, which is the one a migration is about to depend on.
        expect(fs.existsSync(byStamp.get('10:00:04') ?? '')).toBe(true);
    });

    // WR-02: retention read filenames alone, so a .bak that is not a database took a slot from one that is.
    it('spends no retention slot on a backup that does not read as a database', async () => {
        const fx = makeCleanFixture();
        const dir = backupDirFor(fx);
        const good = [at(10, 0, 0), at(10, 0, 1), at(10, 0, 2)];
        const kept: string[] = [];
        for (const now of good) {
            kept.push((await backupDatabase(fx, dir, { now })).backupPath);
        }

        // A validly named .bak whose stamp is the newest of all, and which is not a database.
        const corrupt = path.join(dir, path.basename(fx) + '.2026-09-12T10-00-09-000Z.bak');
        fs.writeFileSync(corrupt, 'this was never a database');

        const deleted = pruneBackups(dir, 3).deleted;

        expect(deleted, 'the corrupt backup was not the one deleted').toEqual([corrupt]);
        expect(fs.existsSync(corrupt)).toBe(false);
        for (const survivor of kept) {
            expect(fs.existsSync(survivor), 'a verified backup was evicted by a corrupt one').toBe(true);
        }
    });

    /*
     * WR-02: the deletion loop had no per-entry guard, so the first EPERM/EBUSY ended the whole sweep - and both
     * callers swallow a throwing prune, so every backup older than a held one was never deleted again with no log
     * line anywhere. A backup held open by a scanner is database-shaped, so it ranks among the readable ones and
     * lands in the middle of the doomed list rather than harmlessly at its end.
     */
    it('deletes the rest of the doomed backups past one it cannot delete, and says which it skipped', async () => {
        const fx = makeCleanFixture();
        const dir = backupDirFor(fx);
        const stamps = [at(10, 0, 0), at(10, 0, 1), at(10, 0, 2), at(10, 0, 3)];
        const made: string[] = [];
        for (const now of stamps) {
            made.push((await backupDatabase(fx, dir, { now })).backupPath);
        }
        // keep=1 dooms the three oldest, and the sweep meets them newest first: [10:00:02, 10:00:01, 10:00:00].
        const held = made[2] ?? '';
        const doomedAfterIt = [made[1] ?? '', made[0] ?? ''];

        const realRm = fs.rmSync.bind(fs);
        const spy = vi.spyOn(fs, 'rmSync').mockImplementation((target: fs.PathLike, options?: fs.RmOptions) => {
            if (String(target) === held) {
                throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' });
            }
            realRm(target, options);
        });
        let swept: ReturnType<typeof pruneBackups>;
        try {
            swept = pruneBackups(dir, 1);
        } finally {
            spy.mockRestore();
        }

        expect(fs.existsSync(held), 'the held backup was deleted after all, so this proves nothing').toBe(true);
        expect(swept.skipped, 'the sweep did not say what it could not delete').toEqual([held]);
        for (const older of doomedAfterIt) {
            expect(fs.existsSync(older), 'a backup behind the held one was never reached').toBe(false);
        }
        expect(swept.deleted.sort()).toEqual([...doomedAfterIt].sort());
        expect(fs.existsSync(made[3] ?? ''), 'retention deleted the newest backup').toBe(true);
    });

    it('ignores files that are not backups it wrote', async () => {
        const fx = makeCleanFixture();
        const dir = backupDirFor(fx);
        await backupDatabase(fx, dir, { now: at(10, 0, 0) });
        await backupDatabase(fx, dir, { now: at(10, 0, 1) });

        const stranger = path.join(dir, 'notes.txt');
        fs.writeFileSync(stranger, 'not mine\n');

        expect(pruneBackups(dir, 1).deleted).toHaveLength(1);
        expect(fs.existsSync(stranger)).toBe(true);
    });
});

// F1 (DATA-03): v1.0.0-1.2.0 databases have no pomodoro_sessions, and a failed backup means no migration runs (D-22).
// Counts are restated here, never imported from the generator.
describe('F1: presence-aware verification on v1.x shapes', () => {
    it('backs up and verifies a shape-A database, reporting its absent pomodoro_sessions as null', async () => {
        const fx = buildLegacyFixture('A');

        const result = await backupDatabase(fx, backupDirFor(fx));

        expect(result.verification.integrity).toBe('ok');
        expect(result.verification.rows).toEqual({
            companies: 2,
            work_sessions: 3,
            settings: 4,
            pomodoro_sessions: null
        });
        expect(result.verification.totalDuration).toBe(9000);
        expect(verifyBackup(result.backupPath)).toEqual(readDatabaseStats(fx));
    });

    it('backs up and verifies a shape-B database (v1.2.0 era), reporting its absent pomodoro_sessions as null', async () => {
        const fx = buildLegacyFixture('B');

        const result = await backupDatabase(fx, backupDirFor(fx));

        expect(result.verification.integrity).toBe('ok');
        expect(result.verification.rows).toEqual({
            companies: 2,
            work_sessions: 3,
            settings: 4,
            pomodoro_sessions: null
        });
        expect(result.verification.totalDuration).toBe(9000);
    });

    const counted: BackupVerification = {
        integrity: 'ok',
        rows: { companies: 2, work_sessions: 3, settings: 4, pomodoro_sessions: 0 },
        totalDuration: 9000
    };

    it('reports a table absent on one side and empty on the other as exactly one mismatch naming it', () => {
        const absent: BackupVerification = { ...counted, rows: { ...counted.rows, pomodoro_sessions: null } };

        const mismatches = describeVerificationMismatches(counted, absent);

        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]).toContain('pomodoro_sessions');
        expect(mismatches[0]).toContain('holds null rows, expected 0');
    });

    it('names a missing duration without inventing a difference', () => {
        const noSessions: BackupVerification = {
            ...counted,
            rows: { ...counted.rows, work_sessions: null },
            totalDuration: null
        };

        const mismatches = describeVerificationMismatches(counted, noSessions);

        expect(mismatches).toEqual([
            'table "work_sessions" holds null rows, expected 3',
            'work_sessions sum(duration) is null, expected 9000'
        ]);
    });
});

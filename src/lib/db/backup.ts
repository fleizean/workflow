/*
 * src/lib/db/backup.ts
 *
 * Back up a live SQLite database, verify the copy before trusting it, restore a verified copy
 * over a damaged database, and prune old copies without ever destroying the newest.
 *
 * This is the module the milestone's core value rests on - "no user ever loses tracked time" -
 * and Phase 4's migration runner (DATA-03) calls it immediately before the first migration
 * statement runs against a real user's database. Three things about its shape are deliberate.
 *
 * 1. IT TAKES AN INJECTED PATH AND IMPORTS NO ELECTRON (D-08). Its only imports are node:fs,
 *    node:path and the SQLite driver. database/db.js is the anti-analog: it opens its connection
 *    at module load from Electron's userData directory - app.getPath, written here without its
 *    call parentheses on purpose, because this plan's module-shape gate greps the file for a
 *    derived path and cannot tell prose from code - and imports electron at the top, so it cannot
 *    be loaded in plain Node at all and cannot be unit-tested without an in-Electron runner.
 *    Every entry point here takes its paths as arguments, which is what makes the proof in
 *    tests/backup.test.ts possible.
 *
 * 2. THE COPY USES SQLite's ONLINE BACKUP API, NEVER A FILE COPY (CUSTODY-03). A file copy of
 *    the main database file omits whatever is still in the -wal sidecar. Measured against the
 *    plan 01-07 fixture: the source holds 45 sessions totalling 22,000 seconds, of which 40
 *    sessions and 4,000 seconds live only in a 329,632-byte sidecar. fs.copyFileSync of the main
 *    file alone recovers 5 sessions and 18,000 seconds - and the result passes
 *    PRAGMA integrity_check. It is not corrupt. It is quietly forty sessions short, and nothing
 *    throws. That silence is the failure mode this module exists to make impossible.
 *
 * 3. VERIFICATION IS INTEGRITY *PLUS* ROW COUNTS *PLUS* SUMMED DURATION, COMPARED AGAINST THE
 *    SOURCE (CUSTODY-04). Integrity alone blesses the short copy above, and a copy's
 *    self-consistency says nothing about whether it is complete. Only a comparison against
 *    statistics read from the source before the copy began can catch a short backup.
 *
 * Every error message names the concrete mismatch - expected against observed - because every
 * failure guarded against here is otherwise silent, and because the person reading the message
 * is likely doing so at three in the morning in the middle of a migration. No message ever
 * carries a row value, a company name or a session note (T-01-37).
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';
import { utcIsoTimestamp } from '@shared/utils/date';

/*
 * The four v1.2.1 tables, as a constant tuple of literals declared here.
 *
 * It is a constant and not a parameter on purpose: these names are interpolated into SQL, which
 * a bound parameter cannot carry (SQLite binds values, not identifiers). Accepting a
 * caller-supplied table name would be an injection vector for no benefit whatsoever (T-01-35).
 */
const COUNTED_TABLES = ['companies', 'work_sessions', 'settings', 'pomodoro_sessions'] as const;

type CountedTable = (typeof COUNTED_TABLES)[number];

/** The sidecars SQLite writes beside a WAL-mode database. */
const SIDECARS = ['-wal', '-shm'] as const;

/** Pages copied per incremental step. The driver's own default once it is past its probe. */
const PAGES_PER_STEP = 100;

/** Wall-clock ceiling on a single backup, in milliseconds. See backupDatabase. */
export const DEFAULT_BACKUP_DEADLINE_MS = 60_000;

/** How many backups pruneBackups keeps by default. Phase 4's DATA-03 asks for the last three. */
export const DEFAULT_RETAINED_BACKUPS = 3;

/**
 * Recognises a file this module wrote: `<database name>.<ISO timestamp>.bak`, where the
 * timestamp has had its colons and dot replaced by hyphens so it is a legal filename on Windows.
 * Because the stamp is ISO-8601, sorting these names lexicographically sorts them by time.
 */
const BACKUP_NAME = /\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/;

/** What a database says about itself: integrity, per-table row counts, and total tracked time. */
export interface BackupVerification {
    integrity: string;
    rows: Record<CountedTable, number>;
    totalDuration: number;
}

export interface BackupResult {
    backupPath: string;
    totalPages: number;
    verification: BackupVerification;
}

export interface BackupOptions {
    /** Injected clock, so the destination filename is deterministic under test. */
    now?: Date;
    /** Wall-clock ceiling for the whole copy. Defaults to DEFAULT_BACKUP_DEADLINE_MS. */
    deadlineMs?: number;
}

function countRows(db: DatabaseType.Database, table: CountedTable): number {
    // `table` is one of COUNTED_TABLES - a literal from this module, never caller input.
    const row = db.prepare<[], { c: number }>('SELECT count(*) AS c FROM "' + table + '"').get();
    if (row === undefined) {
        throw new Error('count(*) over "' + table + '" returned no row, which SQLite cannot do.');
    }
    return row.c;
}

/**
 * Opens `dbPath` read-only and reads everything a backup is judged on.
 *
 * Read-only is not incidental: a read-write connection that reads and then closes CHECKPOINTS,
 * folding the -wal into the main file and deleting the sidecar. Reading the statistics of a
 * live database must not alter it.
 *
 * The duration sum is COALESCEd to zero because bare sum() over zero rows returns NULL, and
 * NULL !== 0 would fail a perfectly good fresh-install backup.
 */
export function readDatabaseStats(dbPath: string): BackupVerification {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const integrity = db.pragma('integrity_check', { simple: true });
        if (typeof integrity !== 'string') {
            throw new Error(
                'PRAGMA integrity_check on ' + dbPath + ' returned ' + typeof integrity +
                ', expected a string. A verification that cannot read its own result is not one.'
            );
        }

        const rows: Record<CountedTable, number> = {
            companies: 0,
            work_sessions: 0,
            settings: 0,
            pomodoro_sessions: 0
        };
        for (const table of COUNTED_TABLES) {
            rows[table] = countRows(db, table);
        }

        const summed = db
            .prepare<[], { s: number }>(
                'SELECT COALESCE(sum(duration), 0) AS s FROM work_sessions'
            )
            .get();
        if (summed === undefined) {
            throw new Error('COALESCE(sum(duration), 0) returned no row, which SQLite cannot do.');
        }

        return { integrity, rows, totalDuration: summed.s };
    } finally {
        db.close();
    }
}

/**
 * Reopens a backup read-only and reports what it contains.
 *
 * This answers "what is in this file", NOT "is this backup good". The second question can only
 * be answered by comparing this result against statistics taken from the source, which is what
 * backupDatabase does - a short copy is perfectly self-consistent and reports integrity ok.
 */
export function verifyBackup(backupPath: string): BackupVerification {
    return readDatabaseStats(backupPath);
}

/**
 * Every way `observed` fails to match `expected`, as sentences naming both values. Empty means
 * the two agree.
 *
 * This is the comparison that catches a short backup, and it is exported because the judgement
 * "is this copy complete" is the module's actual contribution - integrity_check is a check the
 * copy performs on itself, and a copy that is missing four fifths of its rows is perfectly
 * self-consistent. Phase 4's migration runner needs the same judgement, and a test can point it
 * at a genuinely short copy's real numbers rather than at a mock.
 *
 * It reports ALL mismatches rather than the first, because at three in the morning during a
 * migration the difference between "work_sessions is short" and "work_sessions is short AND
 * 4,000 seconds of tracked time are missing" is the difference between one diagnosis and two.
 */
export function describeVerificationMismatches(
    expected: BackupVerification,
    observed: BackupVerification
): string[] {
    const mismatches: string[] = [];
    if (observed.integrity !== 'ok') {
        mismatches.push('integrity_check reported "' + observed.integrity + '", expected "ok"');
    }
    for (const table of COUNTED_TABLES) {
        if (observed.rows[table] !== expected.rows[table]) {
            mismatches.push(
                'table "' + table + '" holds ' + String(observed.rows[table]) +
                ' rows, expected ' + String(expected.rows[table])
            );
        }
    }
    if (observed.totalDuration !== expected.totalDuration) {
        mismatches.push(
            'work_sessions sum(duration) is ' + String(observed.totalDuration) + ', expected ' +
            String(expected.totalDuration) + ' - a difference of ' +
            String(expected.totalDuration - observed.totalDuration) + ' seconds of tracked time'
        );
    }
    return mismatches;
}

/**
 * Copies `sourcePath` into `backupDir` with SQLite's online backup API, then verifies the copy
 * against the source before returning. Throws on any mismatch; the copy is left on disk for
 * inspection only when the driver itself left it there.
 *
 * The destination filename carries a timestamp derived from `options.now`, and an existing
 * destination is refused before anything is written. Both halves matter: the driver opens the
 * destination SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE and overwrites it SILENTLY, and if a
 * backup to a destination that already existed then fails, the half-clobbered file is left
 * behind. A stable `krono.db.bak` would therefore let a second failed migration attempt destroy
 * the good copy the first attempt made (T-01-33).
 *
 * The source is opened read-only. That backs up the full sidecar content and leaves the source's
 * own -wal intact, so backing a database up does not consume it.
 *
 * A progress callback enforces a wall-clock deadline. better-sqlite3 does not sleep on
 * SQLITE_BUSY, and SQLite restarts a backup when the source is written by another connection -
 * "if the backup process is restarted frequently enough it may never run to completion"
 * (sqlite.org/backup.html). The application is single-instance, so this is a low-probability
 * guard; it is here because Phase 4 runs this immediately before a migration, where hanging with
 * no diagnostic is the worst available outcome (T-01-36).
 */
export async function backupDatabase(
    sourcePath: string,
    backupDir: string,
    options: BackupOptions = {}
): Promise<BackupResult> {
    const now = options.now ?? new Date();
    const deadlineMs = options.deadlineMs ?? DEFAULT_BACKUP_DEADLINE_MS;

    fs.mkdirSync(backupDir, { recursive: true });

    const stamp = utcIsoTimestamp(now).replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, path.basename(sourcePath) + '.' + stamp + '.bak');
    if (fs.existsSync(backupPath)) {
        throw new Error(
            'Backup destination already exists and will not be reused: ' + backupPath +
            '. An existing destination is overwritten silently by the driver, and a failed ' +
            'backup to one leaves a half-clobbered file behind.'
        );
    }

    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    let expected: BackupVerification;
    let totalPages: number;
    try {
        expected = readDatabaseStats(sourcePath);
        const startedAt = Date.now();
        const progress = await source.backup(backupPath, {
            progress: (info) => {
                const elapsed = Date.now() - startedAt;
                if (elapsed >= deadlineMs) {
                    throw new Error(
                        'Backup exceeded its wall-clock deadline: ' + String(elapsed) +
                        ' ms elapsed, limit ' + String(deadlineMs) + ' ms, with ' +
                        String(info.remainingPages) + ' of ' + String(info.totalPages) +
                        ' pages still to copy. Source: ' + sourcePath
                    );
                }
                return PAGES_PER_STEP;
            }
        });
        totalPages = progress.totalPages;
    } finally {
        source.close();
    }

    const verification = verifyBackup(backupPath);
    const mismatches = describeVerificationMismatches(expected, verification);
    if (mismatches.length > 0) {
        throw new Error(
            'Backup verification failed for ' + backupPath + ': ' + mismatches.join('; ') +
            '. The copy was NOT trusted.'
        );
    }
    quiesceBackupFile(backupPath);

    return { backupPath, totalPages, verification };
}

/*
 * Removes the sidecars that verifying a freshly-written backup leaves beside it.
 *
 * The online backup API closes and checkpoints its own destination handle, so the file it
 * produces is a single quiescent database. Reopening it - which verification must do - creates
 * a -shm and an empty -wal that a READ-ONLY connection cannot delete on close, because deleting
 * them is a write. Left there, they are two hazards rather than untidiness: restoreDatabase
 * copies the .bak file alone, so any sidecar beside a backup is content the restore would not
 * carry; and a sidecar outlives the .bak it describes once that backup is pruned, which is the
 * "database separated from its WAL" state SQLite warns about, pointed at a file that is gone.
 *
 * A NON-EMPTY -wal here would mean the backup is not self-contained, so it throws rather than
 * deleting: silently removing frames would be the exact silent-loss failure this module exists
 * to prevent. Nothing observed can produce that state - the destination was refused if it
 * already existed and only a read-only connection has touched it - which is why the guard is
 * cheap and why it says what it saw if it ever does fire.
 */
function quiesceBackupFile(backupPath: string): void {
    for (const sidecar of SIDECARS) {
        const companion = backupPath + sidecar;
        if (!fs.existsSync(companion)) continue;
        const size = fs.statSync(companion).size;
        if (size > 0 && sidecar === '-wal') {
            throw new Error(
                'Backup ' + backupPath + ' is not self-contained: its ' + sidecar +
                ' sidecar holds ' + String(size) + ' bytes after verification, so the backup ' +
                'file alone would not carry everything the copy contains.'
            );
        }
        fs.rmSync(companion);
    }
}

function refusalReason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Restores a verified backup over `targetPath` and returns the restored file's statistics.
 *
 * Verification comes first and the restore is refused unless it passes, because this function
 * overwrites a real database: a wrong decision here destroys data rather than merely failing to
 * save it (T-01-34). A backup that cannot even be opened is refused with that reason stated,
 * rather than letting the driver's own error surface unattributed.
 *
 * The target's stale sidecars are removed before the copy. A -wal describing a database that no
 * longer exists is precisely the "database separated from its WAL" hazard SQLite warns about.
 *
 * The file copy below is correct HERE AND ONLY HERE, which is why it carries an inline exemption
 * from the CUSTODY-03 lint rule rather than a quiet workaround: a verified backup is a quiescent
 * single file, closed by the backup API, with no live connection and no sidecars of its own.
 */
export function restoreDatabase(backupPath: string, targetPath: string): BackupVerification {
    let verification: BackupVerification;
    try {
        verification = verifyBackup(backupPath);
    } catch (error) {
        throw new Error(
            'Refusing to restore an unverified backup: ' + backupPath +
            ' could not be opened and read - ' + refusalReason(error)
        );
    }
    if (verification.integrity !== 'ok') {
        throw new Error(
            'Refusing to restore an unverified backup: ' + backupPath +
            ' reported integrity_check "' + verification.integrity + '", expected "ok"'
        );
    }

    for (const sidecar of SIDECARS) {
        const stale = targetPath + sidecar;
        if (fs.existsSync(stale)) fs.rmSync(stale);
    }

    /*
     * eslint-disable-next-line no-restricted-syntax -- CUSTODY-03 forbids copying a SQLite
     * database file because a copy of a LIVE database silently omits its -wal. Sanctioned here,
     * and nowhere else in this module: `backupPath` was produced by the online backup API, which
     * closes and checkpoints its own destination handle, so it is a quiescent single file with
     * no sidecars and no connection open on it. The target's sidecars were removed immediately
     * above, and the result is re-verified immediately below.
     */
    // eslint-disable-next-line no-restricted-syntax
    fs.copyFileSync(backupPath, targetPath);

    const restored = verifyBackup(targetPath);
    const mismatches = describeVerificationMismatches(verification, restored);
    if (mismatches.length > 0) {
        throw new Error(
            'Restore verification failed for ' + targetPath + ': ' + mismatches.join('; ') +
            '. The restored database does not match the backup it came from.'
        );
    }
    return restored;
}

/**
 * Deletes all but the `keep` most recent backups in `backupDir` and returns what it deleted.
 *
 * `keep` is a parameter with a default rather than a constant so Phase 4's DATA-03 can set its
 * own retention policy without editing this module.
 *
 * It never deletes the newest backup, whatever `keep` says - a retention count of zero is not an
 * instruction to destroy the only copy there is, and the newest is the one a migration is about
 * to depend on. It never writes anything, so it cannot overwrite a known-good backup: the only
 * safe interaction with an existing backup file is to leave it alone or remove it.
 *
 * Ordering is by the ISO timestamp in the filename rather than by mtime. The stamp sorts
 * lexicographically in time order, and unlike mtime it does not depend on the filesystem's
 * timestamp resolution - on Windows two files written in the same tick can share an mtime.
 */
export function pruneBackups(backupDir: string, keep: number = DEFAULT_RETAINED_BACKUPS): string[] {
    if (!fs.existsSync(backupDir)) return [];

    const newestFirst = fs
        .readdirSync(backupDir)
        .filter((name) => BACKUP_NAME.test(name))
        .sort()
        .reverse();

    const retained = Math.max(1, Math.trunc(keep));
    const doomed = newestFirst.slice(retained);

    const deleted: string[] = [];
    for (const name of doomed) {
        const target = path.join(backupDir, name);
        fs.rmSync(target);
        deleted.push(target);
    }
    return deleted;
}

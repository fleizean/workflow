// Backs up, verifies, restores and prunes a SQLite database at injected paths; imports no Electron (D-08).
// Copies use the online backup API, because a file copy silently drops the -wal (CUSTODY-03).

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';
import { utcIsoTimestamp } from '@shared/utils/date';
import { assertForeignKeysOn } from './client';

// The v1.2.1 tables. Interpolated into SQL, so never caller input (T-01-35); app_state is deliberately not counted.
const COUNTED_TABLES = ['companies', 'work_sessions', 'settings', 'pomodoro_sessions'] as const;

type CountedTable = (typeof COUNTED_TABLES)[number];

const SIDECARS = ['-wal', '-shm'] as const;

// The staging name a backup is written under. BACKUP_NAME never matches it, so retention never counts one (CR-02).
export const PENDING_SUFFIX = '.partial';

const PENDING_NAME = /\.bak\.partial(-wal|-shm)?$/;

// The staging name a restore copies into before it is verified and moved over the target (WR-03).
const INCOMING_SUFFIX = '.incoming';

// Where the target is moved while the restored file takes its place, so a failed rename destroys nothing (WR-01).
const DISPLACED_SUFFIX = '.replaced';

const PAGES_PER_STEP = 100;

export const DEFAULT_BACKUP_DEADLINE_MS = 60_000;

export const DEFAULT_RETAINED_BACKUPS = 3;

// `<database>.<ISO stamp, with : and . as ->.bak`; the stamp sorts lexicographically by time.
const BACKUP_NAME = /\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.bak$/;

// null marks a counted table the file lacks: v1.0.0-1.2.0 databases have no pomodoro_sessions (F1).
export interface BackupVerification {
    integrity: string;
    rows: Record<CountedTable, number | null>;
    totalDuration: number | null;
}

export interface BackupResult {
    backupPath: string;
    totalPages: number;
    verification: BackupVerification;
}

export interface BackupOptions {
    now?: Date;
    deadlineMs?: number;
    // Test-only kill point (D-24), called first at every progress step.
    onProgress?: (info: { totalPages: number; remainingPages: number }) => void;
}

function countRows(db: DatabaseType.Database, table: CountedTable): number {
    const row = db.prepare<[], { c: number }>('SELECT count(*) AS c FROM "' + table + '"').get();
    if (row === undefined) {
        throw new Error('count(*) over "' + table + '" returned no row, which SQLite cannot do.');
    }
    return row.c;
}

// Read-only on purpose: a read-write connection checkpoints a live -wal away when it closes.
export function readDatabaseStats(dbPath: string): BackupVerification {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        assertForeignKeysOn(db, dbPath);
        const integrity = db.pragma('integrity_check', { simple: true });
        if (typeof integrity !== 'string') {
            throw new Error(
                'PRAGMA integrity_check on ' + dbPath + ' returned ' + typeof integrity +
                ', expected a string. A verification that cannot read its own result is not one.'
            );
        }

        const present = new Set(
            db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all()
                .map((table) => table.name)
        );
        const rows: Record<CountedTable, number | null> = {
            companies: null,
            work_sessions: null,
            settings: null,
            pomodoro_sessions: null
        };
        for (const table of COUNTED_TABLES) {
            rows[table] = present.has(table) ? countRows(db, table) : null;
        }

        let totalDuration: number | null = null;
        if (present.has('work_sessions')) {
            // sum() over zero rows is NULL, and NULL !== 0 would fail a fresh install's backup.
            const summed = db
                .prepare<[], { s: number }>('SELECT COALESCE(sum(duration), 0) AS s FROM work_sessions')
                .get();
            if (summed === undefined) {
                throw new Error('COALESCE(sum(duration), 0) returned no row, which SQLite cannot do.');
            }
            totalDuration = summed.s;
        }

        return { integrity, rows, totalDuration };
    } finally {
        db.close();
    }
}

// What a file contains. Whether a backup is complete takes a comparison with the source (backupDatabase).
export function verifyBackup(backupPath: string): BackupVerification {
    return readDatabaseStats(backupPath);
}

// Every way `observed` differs from `expected`, each naming both values; empty means they agree.
// A table present on one side and absent (null) on the other is a mismatch.
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
        const gap = typeof expected.totalDuration === 'number' && typeof observed.totalDuration === 'number'
            ? ' - a difference of ' + String(expected.totalDuration - observed.totalDuration) +
                ' seconds of tracked time'
            : '';
        mismatches.push(
            'work_sessions sum(duration) is ' + String(observed.totalDuration) + ', expected ' +
            String(expected.totalDuration) + gap
        );
    }
    return mismatches;
}

// Copies into a new timestamped file with the online backup API, then verifies the copy against the source.
// An existing destination is refused because the driver overwrites it silently (T-01-33); a wall-clock deadline
// ends a backup SQLite keeps restarting (T-01-36). The source is read-only, so its -wal survives.
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

    // CR-02: the copy is written under a name pruneBackups cannot see and moved onto the retention-counted one
    // only once it is verified and quiesced, so a failed backup leaves nothing behind to count or to trust.
    const pendingPath = backupPath + PENDING_SUFFIX;

    sweepPendingBackups(backupDir);

    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    let expected: BackupVerification;
    let totalPages: number;
    let verification: BackupVerification;
    try {
        try {
            assertForeignKeysOn(source, sourcePath);
            expected = readDatabaseStats(sourcePath);
            const startedAt = Date.now();
            const progress = await source.backup(pendingPath, {
                progress: (info) => {
                    options.onProgress?.(info);
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

        verification = verifyBackup(pendingPath);
        const mismatches = describeVerificationMismatches(expected, verification);
        if (mismatches.length > 0) {
            throw new Error(
                'Backup verification failed for ' + pendingPath + ': ' + mismatches.join('; ') +
                '. The copy was NOT trusted.'
            );
        }
        quiesceBackupFile(pendingPath);
        // eslint-disable-next-line no-restricted-syntax -- a verified, quiesced copy with no sidecars, never a live database (CUSTODY-03)
        fs.renameSync(pendingPath, backupPath);
    } catch (error) {
        removePendingBackup(pendingPath);
        throw error;
    }

    return { backupPath, totalPages, verification };
}

// Everything a half-written copy may have left. force: true, so a name that was never created is not an error.
function removePendingBackup(pendingPath: string): void {
    fs.rmSync(pendingPath, { force: true });
    for (const sidecar of SIDECARS) {
        fs.rmSync(pendingPath + sidecar, { force: true });
    }
}

// The same, where deleting a leftover is housekeeping rather than part of the outcome.
function removeQuietly(pendingPath: string): void {
    try {
        removePendingBackup(pendingPath);
    } catch {
        // Held open or read-only: it outlives this call, and the next restore tries again.
    }
}

// Staging files a killed copy left behind. They are unverified by construction, so none is ever kept (CR-02).
// WR-04: housekeeping, and it runs before the source is even opened, so it must not be able to fail the backup it
// precedes. force: true suppresses ENOENT only - a held, read-only or directory-shaped leftover still throws, and
// used to refuse the migration on every launch. This run's own staging name is stamped, so one it cannot delete
// never collides with it.
function sweepPendingBackups(backupDir: string): void {
    if (!fs.existsSync(backupDir)) return;
    for (const name of fs.readdirSync(backupDir)) {
        if (!PENDING_NAME.test(name)) continue;
        try {
            fs.rmSync(path.join(backupDir, name), { force: true });
        } catch {
            // Someone else's leftover, not this backup's problem.
        }
    }
}

// Verifying reopens the backup and leaves a -shm and an empty -wal that a read-only connection cannot delete.
// They are removed so restore and prune see one file; a non-empty -wal means the copy is incomplete, so that throws.
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

// Renames `from` out of the way, recording the move so putBack can undo it. A path that is not there is not a move.
function moveAside(from: string, to: string, moved: { from: string; to: string }[]): void {
    if (!fs.existsSync(from)) return;
    // eslint-disable-next-line no-restricted-syntax -- moving a database aside intact, never copying it (CUSTODY-03)
    fs.renameSync(from, to);
    moved.push({ from, to });
}

// Undoes the moves in reverse, so the database is back before its sidecars are.
function putBack(moved: { from: string; to: string }[]): void {
    while (moved.length > 0) {
        const move = moved.pop() as { from: string; to: string };
        // eslint-disable-next-line no-restricted-syntax -- putting the user's own file back where it was (CUSTODY-03)
        fs.renameSync(move.to, move.from);
    }
}

function refusalReason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Restores a verified backup over `targetPath` and re-verifies the result; anything unverifiable is refused before
// the target is touched (T-01-34). WR-03: the copy is staged beside the target and verified there, so a failing or
// interrupted copy can never leave the target truncated with its sidecars already gone. WR-01: the target is moved
// aside rather than deleted from, so every failure path still has the whole of it - database and -wal - to put back.
//
// Not on the database layer's public surface: the app has no restore action, and the failure dialog says so. It is
// the tested recovery procedure behind DATA-03, not something src/main can reach by accident.
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

    const incomingPath = targetPath + INCOMING_SUFFIX;
    removePendingBackup(incomingPath);
    try {
        // eslint-disable-next-line no-restricted-syntax -- the backup API left a quiescent single file (CUSTODY-03)
        fs.copyFileSync(backupPath, incomingPath);

        const restored = verifyBackup(incomingPath);
        const mismatches = describeVerificationMismatches(verification, restored);
        if (mismatches.length > 0) {
            throw new Error(
                'Restore verification failed for ' + targetPath + ': ' + mismatches.join('; ') +
                '. The restored database does not match the backup it came from.'
            );
        }
        quiesceBackupFile(incomingPath);

        // WR-01: the target and its sidecars move aside together and nothing of theirs is deleted until the
        // restored file is in place. Deleting the -wal first cost every uncheckpointed row whenever the rename
        // then failed, which on Windows is an ordinary EPERM/EBUSY from a scanner or a stale handle.
        const displacedPath = targetPath + DISPLACED_SUFFIX;
        // WR-04: a leftover nobody can delete is not a reason to refuse a restore. If it really blocks the way,
        // the move below fails on it and putBack undoes everything; if it does not, it was only in the way of itself.
        removeQuietly(displacedPath);
        const moved: { from: string; to: string }[] = [];
        try {
            // Sidecars first: one that will not move costs nothing while the database is still where it was.
            for (const sidecar of SIDECARS) {
                moveAside(targetPath + sidecar, displacedPath + sidecar, moved);
            }
            moveAside(targetPath, displacedPath, moved);
            // eslint-disable-next-line no-restricted-syntax -- a verified, quiesced file with no sidecars (CUSTODY-03)
            fs.renameSync(incomingPath, targetPath);
        } catch (error) {
            putBack(moved);
            throw error;
        }
        // WR-04: past this point the restore is done - the target is the verified database. Housekeeping after
        // the point of success may not report it as a failure, or the user retries a recovery that worked, this
        // time against the file it already restored.
        removeQuietly(displacedPath);
        return restored;
    } catch (error) {
        // Quietly, so a staging file that will not delete cannot replace the reason the restore was refused.
        removeQuietly(incomingPath);
        throw error;
    }
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1');

// Reads the 16-byte header only: enough to tell a database from a clobbered or truncated file, and it opens no
// connection, so it costs nothing on a 300 MB backup (WR-02).
function looksLikeADatabase(file: string): boolean {
    let handle: number;
    try {
        handle = fs.openSync(file, 'r');
    } catch {
        return false;
    }
    try {
        const head = Buffer.alloc(SQLITE_HEADER.length);
        return fs.readSync(handle, head, 0, head.length, 0) === head.length && head.equals(SQLITE_HEADER);
    } catch {
        return false;
    } finally {
        fs.closeSync(handle);
    }
}

// Deletes all but the `keep` newest backups, ordered by filename stamp rather than mtime, and returns what it
// deleted. WR-02: a file that does not read as a database ranks below every one that does, whatever its stamp,
// so retention can never spend a slot on a corrupt copy while deleting a good one. The newest database-shaped
// backup always survives, whatever `keep` says.
export function pruneBackups(backupDir: string, keep: number = DEFAULT_RETAINED_BACKUPS): string[] {
    if (!fs.existsSync(backupDir)) return [];

    const newestFirst = fs
        .readdirSync(backupDir)
        .filter((name) => BACKUP_NAME.test(name))
        .sort()
        .reverse();

    const readable = new Map(newestFirst.map((name) => [name, looksLikeADatabase(path.join(backupDir, name))]));
    const ranked = [
        ...newestFirst.filter((name) => readable.get(name) === true),
        ...newestFirst.filter((name) => readable.get(name) !== true)
    ];

    const retained = Math.max(1, Math.trunc(keep));
    const doomed = ranked.slice(retained);

    const deleted: string[] = [];
    for (const name of doomed) {
        const target = path.join(backupDir, name);
        fs.rmSync(target);
        deleted.push(target);
    }
    return deleted;
}

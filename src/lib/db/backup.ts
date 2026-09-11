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

    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    let expected: BackupVerification;
    let totalPages: number;
    try {
        assertForeignKeysOn(source, sourcePath);
        expected = readDatabaseStats(sourcePath);
        const startedAt = Date.now();
        const progress = await source.backup(backupPath, {
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

function refusalReason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Restores a verified backup over `targetPath` and re-verifies the result; anything unverifiable is refused before
// the target is touched (T-01-34). The target's stale sidecars go first, so no -wal outlives its database.
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

    // eslint-disable-next-line no-restricted-syntax -- the backup API left a quiescent single file (CUSTODY-03)
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

// Deletes all but the `keep` newest backups, ordered by filename stamp rather than mtime, and returns what it
// deleted. The newest always survives, whatever `keep` says.
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

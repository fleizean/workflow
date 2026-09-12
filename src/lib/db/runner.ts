// Brings a classified database to the last injected step, one immediate transaction per step (D-07).
// Steps, baseline, backup directory and clock are injected (D-10); the runner never renames, replaces or restores a file.

import fs from 'node:fs';
import type DatabaseType from 'better-sqlite3';
import { isLocalDate } from '@shared/utils/date';
import { backupDatabase, DEFAULT_RETAINED_BACKUPS, pruneBackups, type BackupOptions } from './backup';
import { applyV121Baseline } from './baseline-v121';
import type { DbClass } from './classify';
import { MIGRATIONS } from './migrations/registry';

export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

// Module constants, never caller text: they are interpolated into SQL (T-04-19).
const DATE_TABLES = ['work_sessions', 'pomodoro_sessions'] as const;
const SESSIONS_TABLE = 'work_sessions';

/** Columns the app reads afterwards, checked inside the step's own transaction (WR-02). */
export interface RequiredColumns {
    readonly table: string;
    readonly columns: readonly string[];
}

export type MigrationStep =
    | { readonly version: 1; readonly tag: string; readonly kind: 'baseline'; readonly ensures?: readonly RequiredColumns[] }
    | {
        readonly version: number;
        readonly tag: string;
        readonly kind: 'sql';
        readonly sql: string;
        readonly ensures?: readonly RequiredColumns[];
    };

export interface RunnerHooks {
    // Test-only kill points.
    insideTransaction?: (version: number) => void;
    afterCommit?: (version: number) => void;
    onBackupProgress?: BackupOptions['onProgress'];
}

export interface MigrationOptions {
    dbPath: string;
    dbClass: DbClass;
    fromVersion: number;
    backupDir: string;
    // Both default to production: the real registry and the D-13 replay. An explicit
    // `applyBaseline: undefined` still means "no baseline supplied".
    steps?: readonly MigrationStep[];
    applyBaseline?: (db: DatabaseType.Database) => void;
    now?: Date;
    hooks?: RunnerHooks;
}

// Counted before the first step and never repaired (D-15).
export interface AnomalyCounts {
    foreignKeyViolations: number;
    orphanedSessions: number;
    malformedDates: number;
    invalidDurations: number;
}

export interface MigrationReport {
    dbClass: DbClass;
    fromVersion: number;
    toVersion: number;
    applied: number[];
    backupPath: string | null;
    pruned: string[];
    anomalies: AnomalyCounts;
}

function describeCause(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

export class MigrationFailedError extends Error {
    readonly version: number;
    readonly backupPath: string | null;
    override readonly cause: unknown;

    constructor(version: number, backupPath: string | null, cause: unknown) {
        super(
            'Migration to version ' + String(version) + ' did not complete; the database stays at its previous ' +
            'version. ' + (backupPath === null ? 'No backup was taken.' : 'Verified backup: ' + backupPath + '.') +
            ' Cause: ' + describeCause(cause)
        );
        this.name = 'MigrationFailedError';
        this.version = version;
        this.backupPath = backupPath;
        this.cause = cause;
    }
}

export function splitStatements(sql: string): string[] {
    return sql.split(STATEMENT_BREAKPOINT).map((chunk) => chunk.trim()).filter((chunk) => chunk !== '');
}

// Refuses a step list that is not exactly 1..N in order, or that holds a step with nothing to run.
function validateSteps(steps: readonly MigrationStep[]): void {
    steps.forEach((step, index) => {
        const expected = index + 1;
        const version: number = step.version;
        if (!Number.isSafeInteger(version) || version !== expected) {
            throw new Error(
                'Migration steps must be numbered 1..' + String(steps.length) + ' without gaps or duplicates; ' +
                'position ' + String(expected) + ' holds version ' + String(version) + ' (' + step.tag + ').'
            );
        }
        if (step.kind === 'baseline' && version !== 1) {
            throw new Error('Only version 1 may be the baseline step; version ' + String(version) + ' is one.');
        }
        if (step.kind === 'sql' && splitStatements(step.sql).length === 0) {
            throw new Error('Migration version ' + String(version) + ' (' + step.tag + ') has no statements.');
        }
    });
}

function readUserVersion(db: DatabaseType.Database): number {
    const version = db.pragma('user_version', { simple: true });
    if (typeof version !== 'number') {
        throw new Error('PRAGMA user_version returned ' + typeof version + ', expected a number.');
    }
    return version;
}

// The table named by each foreign_key_check row; the count is the violation total.
function violationTables(db: DatabaseType.Database): string[] {
    const rows = db.pragma('foreign_key_check');
    if (!Array.isArray(rows)) {
        throw new Error('PRAGMA foreign_key_check returned ' + typeof rows + ', expected rows.');
    }
    return (rows as readonly unknown[]).map((row) => {
        const table = (row as { table?: unknown }).table;
        return typeof table === 'string' ? table : '';
    });
}

function presentTables(db: DatabaseType.Database): Set<string> {
    const rows = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    return new Set(rows.map((row) => row.name));
}

function countAnomalies(db: DatabaseType.Database): AnomalyCounts {
    const present = presentTables(db);
    const tables = violationTables(db);

    let malformedDates = 0;
    for (const table of DATE_TABLES) {
        if (!present.has(table)) continue;
        for (const row of db.prepare<[], { date: unknown }>('SELECT date FROM "' + table + '"').iterate()) {
            if (!isLocalDate(row.date)) malformedDates += 1;
        }
    }

    let invalidDurations = 0;
    if (present.has(SESSIONS_TABLE)) {
        const counted = db.prepare<[], { c: number }>(
            'SELECT count(*) AS c FROM "' + SESSIONS_TABLE + '" ' +
            "WHERE typeof(duration) <> 'integer' OR duration < 0"
        ).get();
        invalidDurations = counted?.c ?? 0;
    }

    return {
        foreignKeyViolations: tables.length,
        orphanedSessions: tables.filter((table) => table === SESSIONS_TABLE).length,
        malformedDates,
        invalidDurations
    };
}

const sizeOf = (file: string): number => (fs.existsSync(file) ? fs.statSync(file).size : 0);

// A file with nothing in it has nothing to back up; committed rows may still live only in the -wal.
const hasContent = (dbPath: string): boolean => sizeOf(dbPath) > 0 || sizeOf(dbPath + '-wal') > 0;

// Best effort on both paths (CR-02): retention is housekeeping. On the failure path it must not mask the
// migration failure the caller is about to raise; on the success path an undeletable stray in backups/ must not
// turn a committed migration into a reported one.
function pruneBestEffort(backupDir: string, backupPath: string | null): string[] {
    if (backupPath === null) return [];
    try {
        return pruneBackups(backupDir, DEFAULT_RETAINED_BACKUPS);
    } catch {
        return [];
    }
}

// WR-02: every CREATE in the v2 step carries IF NOT EXISTS, so a table of the right name in the wrong shape
// makes the step a no-op. Checked here, inside the step's transaction and before the version bump, so such a file
// is refused loudly rather than stamped current with columns the app cannot read.
// WR-03: the refusal repeats on every launch, so it names the one thing that ends it. Workflow will not rename or
// drop a table it did not create; saying "start it again" without saying that would be advice that cannot work.
function assertRequiredColumns(db: DatabaseType.Database, step: MigrationStep): void {
    for (const required of step.ensures ?? []) {
        const present = new Set(
            db.prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?)')
                .all(required.table)
                .map((row) => row.name)
        );
        const missing = required.columns.filter((column) => !present.has(column));
        if (missing.length > 0) {
            throw new Error(
                'Version ' + String(step.version) + ' left "' + required.table + '" without the column' +
                (missing.length === 1 ? ' ' : 's ') + missing.join(', ') +
                '. A table of that name was already there in another shape, and the app reads those columns. ' +
                'Workflow will not rename or delete a table it did not create, so every launch stops here until ' +
                '"' + required.table + '" is renamed or removed - starting Workflow again on its own changes nothing.'
            );
        }
    }
}

function expectedClassFor(fromVersion: number, latest: number): readonly DbClass[] {
    if (fromVersion === 0) return ['fresh', 'legacy'];
    if (fromVersion === latest) return ['current'];
    return ['current-behind'];
}

function applyStep(
    db: DatabaseType.Database,
    step: MigrationStep,
    applyBaseline: ((db: DatabaseType.Database) => void) | undefined,
    hooks: RunnerHooks | undefined
): void {
    const violationsBefore = violationTables(db).length;
    db.transaction(() => {
        if (step.kind === 'baseline') {
            if (applyBaseline === undefined) {
                throw new Error('Version 1 is the baseline step, and no baseline was supplied.');
            }
            applyBaseline(db);
        } else {
            for (const chunk of splitStatements(step.sql)) {
                db.prepare(chunk).run();
            }
        }
        const violationsAfter = violationTables(db).length;
        if (violationsAfter > violationsBefore) {
            throw new Error(
                'Version ' + String(step.version) + ' raised foreign_key_check violations from ' +
                String(violationsBefore) + ' to ' + String(violationsAfter) + '.'
            );
        }
        assertRequiredColumns(db, step);
        db.pragma('user_version = ' + String(step.version));
        hooks?.insideTransaction?.(step.version);
    }).immediate();
}

export async function migrateDatabase(db: DatabaseType.Database, options: MigrationOptions): Promise<MigrationReport> {
    const { dbPath, dbClass, fromVersion, hooks } = options;
    const steps = options.steps ?? MIGRATIONS;
    const applyBaseline = 'applyBaseline' in options ? options.applyBaseline : applyV121Baseline;
    validateSteps(steps);
    const latest = steps.length;

    if (dbClass === 'newer' || dbClass === 'unrecognized') {
        throw new Error('Refusing to migrate ' + dbPath + ': it is classified ' + dbClass + '.');
    }
    if (!Number.isSafeInteger(fromVersion) || fromVersion < 0 || fromVersion > latest) {
        throw new Error('fromVersion ' + String(fromVersion) + ' is outside 0..' + String(latest) + '.');
    }
    if (!expectedClassFor(fromVersion, latest).includes(dbClass)) {
        throw new Error('A database classified ' + dbClass + ' cannot be at version ' + String(fromVersion) + '.');
    }
    const observed = readUserVersion(db);
    if (observed !== fromVersion) {
        throw new Error(
            dbPath + ' reads user_version ' + String(observed) + ', but it was classified at ' + String(fromVersion) + '.'
        );
    }

    const pending = steps.filter((step) => step.version > fromVersion);
    const baseline = pending.find((step) => step.kind === 'baseline');
    if (baseline !== undefined && applyBaseline === undefined) {
        throw new MigrationFailedError(
            baseline.version, null, new Error('Version 1 is the baseline step, and no baseline was supplied.')
        );
    }

    const anomalies = countAnomalies(db);

    let backupPath: string | null = null;
    const firstPending = pending[0];
    if (firstPending !== undefined && (dbClass === 'legacy' || dbClass === 'current-behind') && hasContent(dbPath)) {
        const backupOptions: BackupOptions = {};
        if (options.now !== undefined) backupOptions.now = options.now;
        if (hooks?.onBackupProgress !== undefined) backupOptions.onProgress = hooks.onBackupProgress;
        try {
            backupPath = (await backupDatabase(dbPath, options.backupDir, backupOptions)).backupPath;
        } catch (error) {
            throw new MigrationFailedError(firstPending.version, null, error);
        }
    }

    const applied: number[] = [];
    for (const step of pending) {
        try {
            applyStep(db, step, applyBaseline, hooks);
        } catch (error) {
            // CR-02: a migration that fails on every launch takes a fresh backup on every launch. Pruning here
            // too is what keeps that loop bounded at the retained count instead of filling the disk.
            pruneBestEffort(options.backupDir, backupPath);
            throw new MigrationFailedError(step.version, backupPath, error);
        }
        applied.push(step.version);
        hooks?.afterCommit?.(step.version);
    }

    const pruned = pruneBestEffort(options.backupDir, backupPath);
    return { dbClass, fromVersion, toVersion: readUserVersion(db), applied, backupPath, pruned, anomalies };
}

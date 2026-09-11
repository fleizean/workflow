// Brings a classified database to the last injected step, one immediate transaction per step (D-07).
// Steps, baseline, backup directory and clock are injected (D-10); the runner never renames, replaces or restores a file.

import type DatabaseType from 'better-sqlite3';
import type { DbClass } from './classify';

export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

export type MigrationStep =
    | { readonly version: 1; readonly tag: string; readonly kind: 'baseline' }
    | { readonly version: number; readonly tag: string; readonly kind: 'sql'; readonly sql: string };

export interface RunnerHooks {
    // Test-only kill points.
    insideTransaction?: (version: number) => void;
    afterCommit?: (version: number) => void;
}

export interface MigrationOptions {
    dbPath: string;
    dbClass: DbClass;
    fromVersion: number;
    backupDir: string;
    steps: readonly MigrationStep[];
    applyBaseline?: (db: DatabaseType.Database) => void;
    now?: Date;
    hooks?: RunnerHooks;
}

export interface MigrationReport {
    dbClass: DbClass;
    fromVersion: number;
    toVersion: number;
    applied: number[];
    backupPath: string | null;
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
        if (!Number.isSafeInteger(step.version) || step.version !== expected) {
            throw new Error(
                'Migration steps must be numbered 1..' + String(steps.length) + ' without gaps or duplicates; ' +
                'position ' + String(expected) + ' holds version ' + String(step.version) + ' (' + step.tag + ').'
            );
        }
        const version: number = step.version;
        if (step.kind === 'baseline' && version !== 1) {
            throw new Error('Only version 1 may be the baseline step; version ' + String(version) + ' is one.');
        }
        if (step.kind === 'sql' && splitStatements(step.sql).length === 0) {
            throw new Error('Migration version ' + String(step.version) + ' (' + step.tag + ') has no statements.');
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

function expectedClassFor(fromVersion: number, latest: number): readonly DbClass[] {
    if (fromVersion === 0) return ['fresh', 'legacy'];
    if (fromVersion === latest) return ['current'];
    return ['current-behind'];
}

function countViolations(db: DatabaseType.Database): number {
    const rows = db.pragma('foreign_key_check');
    if (!Array.isArray(rows)) {
        throw new Error('PRAGMA foreign_key_check returned ' + typeof rows + ', expected rows.');
    }
    return rows.length;
}

function applyStep(db: DatabaseType.Database, step: MigrationStep, options: MigrationOptions): void {
    const violationsBefore = countViolations(db);
    db.transaction(() => {
        if (step.kind === 'baseline') {
            if (options.applyBaseline === undefined) {
                throw new Error('Version 1 is the baseline step, and no baseline was supplied.');
            }
            options.applyBaseline(db);
        } else {
            for (const chunk of splitStatements(step.sql)) {
                db.prepare(chunk).run();
            }
        }
        const violationsAfter = countViolations(db);
        if (violationsAfter > violationsBefore) {
            throw new Error(
                'Version ' + String(step.version) + ' raised foreign_key_check violations from ' +
                String(violationsBefore) + ' to ' + String(violationsAfter) + '.'
            );
        }
        db.pragma('user_version = ' + String(step.version));
        options.hooks?.insideTransaction?.(step.version);
    }).immediate();
}

export async function migrateDatabase(db: DatabaseType.Database, options: MigrationOptions): Promise<MigrationReport> {
    const { dbPath, dbClass, fromVersion, steps } = options;
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
    const backupPath: string | null = null;
    const applied: number[] = [];
    for (const step of pending) {
        try {
            applyStep(db, step, options);
        } catch (error) {
            throw new MigrationFailedError(step.version, backupPath, error);
        }
        applied.push(step.version);
        options.hooks?.afterCommit?.(step.version);
    }

    await Promise.resolve();
    return { dbClass, fromVersion, toVersion: readUserVersion(db), applied, backupPath };
}

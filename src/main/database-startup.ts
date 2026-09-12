// D-30: door, read-only probe, classification, refusal, open, migrate, then the main window - over injected ports.
// No electron here, so the same sequence serves the app and the smoke; the database layer is a type only.

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import type * as DatabaseLayerModule from '../lib/db';
import { EXIT_CODES } from './config';
import { describeError } from './errors';
import type { LegacyStorageSession } from './legacy-storage';
import { productionDataDoorRefuses } from './userdata-path';

export type DatabaseLayer = typeof DatabaseLayerModule;

type DatabaseHandle = ReturnType<DatabaseLayer['openDatabase']>;
type MigrationReport = Awaited<ReturnType<DatabaseLayer['migrateDatabase']>>;

/** What step 8 did, or why it did nothing: best effort, so a failure is a value rather than a throw. */
export type LegacyImportStatus =
    | ReturnType<DatabaseLayer['importLegacyState']>
    | { readonly failed: string };

export const DATABASE_FILE = 'krono.db';
export const BACKUP_DIR = 'backups';

export type ReportKind = 'door' | 'refused' | 'failed';

export interface StartupEnvironment {
    readonly userDataDir: string;
    readonly productionDir: string;
    readonly isPackaged: boolean;
    readonly doorOpen: boolean;
    readonly now: Date;
}

// Every side effect startup needs, so a test drives the real sequence with recording stand-ins.
export interface StartupPorts {
    report(kind: ReportKind, title: string, body: string): void;
    exit(code: number): void;
    log(line: string): void;
    readLegacyStorage(): Promise<LegacyStorageSession>;
    openMainWindow(): void;
}

export interface StartedDatabase {
    readonly db: DatabaseHandle;
    readonly report: MigrationReport;
    readonly legacyImport: LegacyImportStatus;
    readonly close: () => void;
}

export const REFUSAL_TITLE = 'Workflow will not open this database';
export const DOOR_TITLE = 'Workflow development build';
export const FAILURE_TITLE = 'Workflow could not open your database';

const UNCHANGED = 'Nothing in it was changed.';

// Paths, versions and counts only - never a company name, session name or note (T-01-37).
export function refusalMessage(
    kind: 'newer' | 'unrecognized',
    details: { userVersion: number; latest: number; dbPath: string }
): string {
    const head = kind === 'newer'
        ? 'This database was written by a newer version of Workflow (format version ' +
            String(details.userVersion) + '; this version understands ' + String(details.latest) + ').'
        : 'This file is not a Workflow database, so Workflow will not write to it.';
    return head + ' ' + UNCHANGED + '\n\n' + details.dbPath + '\n\n' +
        'Install the latest version of Workflow and start it again.';
}

export function doorMessage(productionDir: string): string {
    return 'This development build of Workflow will not open the installed application\'s data directory, ' +
        'so your real database cannot be changed by it. ' + UNCHANGED + '\n\n' + productionDir + '\n\n' +
        'Start the installed version of Workflow instead.';
}

// WR-03: the app has no restore action, so the backup is described as a file to keep, never as something
// Workflow will put back on its own.
export function failureMessage(details: { dbPath: string; backupPath: string | null; reason: string }): string {
    const backup = details.backupPath === null
        ? 'No backup was taken.'
        : 'A verified copy of it, taken before anything was attempted, is at:\n' + details.backupPath;
    return 'Workflow stopped instead of changing your database, which is still there as it was.\n\n' +
        details.dbPath + '\n\n' + backup + '\n\nReason: ' + details.reason +
        '\n\nNo database was created, renamed or replaced. Install the latest version of Workflow and ' +
        'start it again; if this repeats, copy that file somewhere safe before doing anything else.';
}

function summaryLine(report: MigrationReport): string {
    const { anomalies } = report;
    return 'database: ' + report.dbClass + ' ' + String(report.fromVersion) + ' -> ' + String(report.toVersion) +
        ' applied=[' + report.applied.join(',') + '] backup=' + (report.backupPath ?? 'none') +
        ' anomalies fk=' + String(anomalies.foreignKeyViolations) +
        ' orphans=' + String(anomalies.orphanedSessions) +
        ' dates=' + String(anomalies.malformedDates) +
        ' durations=' + String(anomalies.invalidDurations);
}

// D-32: the -wal is folded back into the database, so the next launch - or a v1.2.1 downgrade - finds one file.
// CR-01: a checkpoint that throws (SQLITE_BUSY, a full disk) is returned rather than raised, so the connection
// still closes and the caller still reports the failure this close was part of.
function closeHandle(layer: DatabaseLayer, db: DatabaseHandle): string | null {
    if (!db.open) {
        return null;
    }
    let checkpointError: string | null = null;
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
        checkpointError = describeError(error);
    } finally {
        layer.closeDatabase(db);
    }
    return checkpointError;
}

// D-31: report, then exit. app.exit skips will-quit, so the caller closes any connection before this runs.
function reportFailure(
    ports: StartupPorts,
    details: { dbPath: string; backupPath: string | null; reason: string }
): void {
    ports.report('failed', FAILURE_TITLE, failureMessage(details));
    ports.exit(EXIT_CODES.databaseFailed);
}

// D-33: best effort. A read that fails or times out is logged by reason and retried on the next launch, and the
// log carries outcomes only - never the saved timer string (T-01-37). The caller releases the returned session.
interface LegacyImportAttempt {
    readonly session: LegacyStorageSession | null;
    readonly status: LegacyImportStatus;
}

async function importLegacyTimer(
    layer: DatabaseLayer,
    db: DatabaseHandle,
    env: StartupEnvironment,
    ports: StartupPorts
): Promise<LegacyImportAttempt> {
    let session: LegacyStorageSession;
    try {
        session = await ports.readLegacyStorage();
    } catch (error) {
        const reason = describeError(error);
        ports.log('legacy timer: not read - ' + reason + '; the next launch retries');
        return { session: null, status: { failed: reason } };
    }

    const { read } = session;
    if (!read.ok) {
        ports.log('legacy timer: not read - ' + read.reason + '; the next launch retries');
        return { session, status: { failed: read.reason } };
    }

    try {
        const outcome = layer.importLegacyState(db, {
            timerState: read.timerState,
            lastGoalNotificationDate: read.lastGoalNotificationDate
        }, env.now);
        ports.log('legacy timer: timerState ' + outcome.timerState + ', goalDate ' + outcome.goalDate);
        return { session, status: outcome };
    } catch (error) {
        // The database is migrated and intact; only the import is skipped.
        const reason = describeError(error);
        ports.log('legacy timer: not imported - ' + reason + '; the next launch retries');
        return { session, status: { failed: reason } };
    }
}

/** Returns the open connection, or null when startup reported and exited. Never creates a replacement database. */
export async function startDatabase(
    layer: DatabaseLayer,
    env: StartupEnvironment,
    ports: StartupPorts
): Promise<StartedDatabase | null> {
    const dbPath = join(env.userDataDir, DATABASE_FILE);

    // D-36 first: nothing may open the production directory's krono.db while the door is closed.
    if (productionDataDoorRefuses({
        isPackaged: env.isPackaged,
        doorOpen: env.doorOpen,
        userDataDir: env.userDataDir,
        productionDir: env.productionDir
    })) {
        ports.report('door', DOOR_TITLE, doorMessage(env.productionDir));
        ports.exit(EXIT_CODES.doorClosed);
        return null;
    }

    const probe = layer.probeDatabase(dbPath);
    if (!probe.ok) {
        reportFailure(ports, { dbPath, backupPath: null, reason: probe.reason });
        return null;
    }

    const latest = layer.LATEST;
    const dbClass = layer.classify(probe.observed, latest);
    if (dbClass === 'newer' || dbClass === 'unrecognized') {
        const details = { userVersion: probe.observed.userVersion, latest, dbPath };
        ports.report('refused', REFUSAL_TITLE, refusalMessage(dbClass, details));
        ports.exit(dbClass === 'newer' ? EXIT_CODES.refusedNewer : EXIT_CODES.refusedUnrecognized);
        return null;
    }

    const parent = dirname(dbPath);
    if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
    }

    // WR-01: the journal mode lives in the file header, so writing it is a mutation. On anything that already
    // holds the user's rows it waits until migrateDatabase has taken the backup; a fresh file has nothing to
    // lose, so it gets v1.2.1's mode at once.
    let db: DatabaseHandle;
    try {
        db = layer.openDatabase(dbPath, { deferJournalMode: dbClass !== 'fresh' });
    } catch (error) {
        reportFailure(ports, { dbPath, backupPath: null, reason: describeError(error) });
        return null;
    }

    let report: MigrationReport;
    try {
        report = await layer.migrateDatabase(db, {
            dbPath,
            dbClass,
            fromVersion: probe.observed.userVersion,
            backupDir: join(env.userDataDir, BACKUP_DIR),
            now: env.now
        });
        layer.setJournalModeWal(db, dbPath);
    } catch (error) {
        // The rollback already left the file as it was: nothing here renames, replaces or restores it (D-31).
        const checkpointError = closeHandle(layer, db);
        reportFailure(ports, {
            dbPath,
            backupPath: error instanceof layer.MigrationFailedError ? error.backupPath : null,
            reason: describeError(error) +
                (checkpointError === null ? '' : ' (and the -wal could not be flushed: ' + checkpointError + ')')
        });
        return null;
    }
    ports.log(summaryLine(report));

    const legacy = await importLegacyTimer(layer, db, env, ports);

    try {
        ports.openMainWindow();
    } catch (error) {
        // WR-08: no window means no app, and index.ts's catch-all calls app.exit, which skips will-quit. Nothing
        // else would ever close this connection, so it closes here.
        closeHandle(layer, db);
        throw error;
    } finally {
        // Pitfall 4: destroying the extractor before a main window exists fires window-all-closed, which quits the app.
        legacy.session?.release();
    }

    return { db, report, legacyImport: legacy.status, close: (): void => { closeHandle(layer, db); } };
}

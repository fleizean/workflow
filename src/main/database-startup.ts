// D-30: door, read-only probe, classification, refusal, open, migrate, then the main window - over injected ports.
// No electron here, so the same sequence serves the app and the smoke; the database layer is a type only.

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import type * as DatabaseLayerModule from '../lib/db';
import { EXIT_CODES } from './config';
import type { LegacyStorageSession } from './legacy-storage';
import { productionDataDoorRefuses } from './userdata-path';

export type DatabaseLayer = typeof DatabaseLayerModule;

type DatabaseHandle = ReturnType<DatabaseLayer['openDatabase']>;
type MigrationReport = Awaited<ReturnType<DatabaseLayer['migrateDatabase']>>;

export const DATABASE_FILE = 'krono.db';
export const BACKUP_DIR = 'backups';

export type ReportKind = 'door' | 'refused' | 'failed';

export interface StartupEnvironment {
    readonly userDataDir: string;
    readonly productionDir: string;
    readonly isPackaged: boolean;
    readonly smoke: boolean;
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

export function failureMessage(details: { dbPath: string; backupPath: string | null; reason: string }): string {
    const backup = details.backupPath === null
        ? 'No backup was taken.'
        : 'A verified backup of it is at:\n' + details.backupPath;
    return 'Workflow stopped instead of changing your database, which is still there as it was.\n\n' +
        details.dbPath + '\n\n' + backup + '\n\nReason: ' + details.reason +
        '\n\nNo database was created, renamed or replaced. Install the latest version of Workflow and ' +
        'start it again; if this repeats, keep that backup safe.';
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
        smoke: env.smoke,
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
        throw new Error('Could not read ' + dbPath + ' - ' + probe.reason);
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

    const db = layer.openDatabase(dbPath);
    const report = await layer.migrateDatabase(db, {
        dbPath,
        dbClass,
        fromVersion: probe.observed.userVersion,
        backupDir: join(env.userDataDir, BACKUP_DIR),
        now: env.now
    });
    ports.log(summaryLine(report));

    ports.openMainWindow();

    return { db, report, close: (): void => { layer.closeDatabase(db); } };
}

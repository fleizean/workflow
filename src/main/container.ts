// The one composition root (ARCH-01): adapters, then repositories over the connection database-startup.ts opened,
// then the services. It opens nothing itself - the door, the classification and the migration stay in
// database-startup.ts - and it names no Electron API, only the adapter factories that do.
// The database layer arrives as an argument, so loading this module still loads no database code (D-10).

import { createElectronPorts } from './adapters';
import type { DatabaseLayer, StartedDatabase } from './database-startup';
import type { AppPorts } from './ports';
import type {
    CompaniesRepository, PomodoroRepository, RepositoryOptions, SessionsRepository, SettingsRepository, SkippedRowReport
} from '../lib/db';

export interface Repositories {
    readonly sessions: SessionsRepository;
    readonly companies: CompaniesRepository;
    readonly settings: SettingsRepository;
    readonly pomodoro: PomodoroRepository;
}

export interface AppContainer {
    readonly ports: AppPorts;
    readonly repositories: Repositories;
    /** One BEGIN IMMEDIATE around `work`, so a service can compose two repositories without holding the handle. */
    transaction<T>(work: () => T): T;
}

export interface ContainerInput {
    readonly layer: DatabaseLayer;
    /** The open connection startDatabase returned; the container never opens or closes one. */
    readonly connection: StartedDatabase['db'];
    readonly log: (line: string) => void;
    /** The Electron and Node adapters unless a caller supplies its own; nothing in production does. */
    readonly ports?: AppPorts;
}

/*
 * A database a third-party tool edited can hold many unmappable rows, and every list() would report each one again.
 * So a given table/column/row/reason is reported once per run, and the whole reporter falls silent after this many
 * distinct reports: a log that fills the disk is a worse outcome than an anomaly reported once and then counted.
 */
export const SKIPPED_ROW_REPORT_LIMIT = 50;

/** Table, column, row id and reason only - never a stored value, because a session name or a note is user data. */
export function skippedRowLine(skipped: SkippedRowReport): string {
    const where = skipped.rowId === null ? 'no row id' : 'row ' + String(skipped.rowId);
    return 'database: ' + skipped.table + '.' + skipped.column + ', ' + where +
        ' was left out of a result - ' + skipped.reason;
}

export function createSkippedRowReporter(log: (line: string) => void): (skipped: SkippedRowReport) => void {
    const seen = new Set<string>();
    let suppressed = false;
    return (skipped) => {
        const key = skipped.table + '.' + skipped.column + '#' + String(skipped.rowId) + '|' + skipped.reason;
        if (seen.has(key)) {
            return;
        }
        if (seen.size >= SKIPPED_ROW_REPORT_LIMIT) {
            if (!suppressed) {
                suppressed = true;
                log('database: further unreadable rows will not be reported this run (' +
                    String(SKIPPED_ROW_REPORT_LIMIT) + ' already were)');
            }
            return;
        }
        seen.add(key);
        log(skippedRowLine(skipped));
    };
}

export function createContainer(input: ContainerInput): AppContainer {
    const { layer, log } = input;
    const ports = input.ports ?? createElectronPorts(log);
    const handle = layer.createDbHandle(input.connection);
    // Slice B's reporter, wired here for the first time: until now an unmappable row was dropped in silence.
    const options: RepositoryOptions = { onSkippedRow: createSkippedRowReporter(log) };

    return {
        ports,
        repositories: {
            sessions: layer.createSessionsRepository(handle, options),
            companies: layer.createCompaniesRepository(handle, options),
            settings: layer.createSettingsRepository(handle),
            pomodoro: layer.createPomodoroRepository(handle, options)
        },
        transaction: (work) => layer.transact(handle, work)
    };
}

let active: AppContainer | undefined;

/** Set once startup has a migrated database; the ipc/ layer resolves its services through activeContainer(). */
export function setActiveContainer(container: AppContainer): void {
    active = container;
}

/** Cleared when the database closes, so a repository over a closed connection is never handed out (D-32). */
export function clearActiveContainer(): void {
    active = undefined;
}

export function activeContainer(): AppContainer {
    if (active === undefined) {
        throw new Error('src/main/container.ts: no container is active; the database is not open');
    }
    return active;
}

// ARCH-01: the one composition root. It wires adapters, repositories and the skipped-row reporter over a connection
// database-startup.ts already opened, and it opens, migrates and closes nothing itself - the guarded layer below is
// what proves that rather than the reading of it.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import ts from 'typescript';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';
import * as realLayer from '../src/lib/db';
import type { SkippedRowReport } from '../src/lib/db';
import {
    SKIPPED_ROW_REPORT_LIMIT, activeContainer, clearActiveContainer, createContainer, createSkippedRowReporter,
    disposeActiveContainer, setActiveContainer, skippedRowLine
} from '../src/main/container';
import type { AppContainer } from '../src/main/container';
import type { DatabaseLayer } from '../src/main/database-startup';
import { closeDatabaseNow } from '../src/main/lifecycle';
import type { AppPorts } from '../src/main/ports';
import { buildLegacyFixture, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
import { cleanupFixtures, makeCleanFixture } from './fixtures/seed';
import { findAll, read } from './helpers/ts-imports';
import type { LocalDate } from '../src/shared/types';

const LIFECYCLE = 'src/main/lifecycle.ts';
const ld = (text: string): LocalDate => text as LocalDate;

const opened: DatabaseType.Database[] = [];

afterAll(() => {
    for (const connection of opened) realLayer.closeDatabase(connection);
    cleanupLegacyFixtures();
    cleanupFixtures();
});

/** The production chain, exactly as startDatabase runs it, up to the point the container takes over. */
async function migratedConnection(dbPath: string): Promise<DatabaseType.Database> {
    const probe = realLayer.probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    const connection = realLayer.openDatabase(dbPath);
    opened.push(connection);
    await realLayer.migrateDatabase(connection, {
        dbPath,
        dbClass: realLayer.classify(probe.observed, realLayer.LATEST),
        fromVersion: probe.observed.userVersion,
        backupDir: path.join(path.dirname(dbPath), 'backups')
    });
    return connection;
}

/*
 * The layer with every door-and-migration entry point replaced by a throw. The container is handed this, so a
 * container that probed, opened, migrated or closed anything of its own would fail rather than be argued about.
 */
function guardedLayer(): DatabaseLayer {
    const refuse = (name: string) => (): never => {
        throw new Error('the container called ' + name + '; startDatabase owns that step');
    };
    return {
        ...realLayer,
        probeDatabase: refuse('probeDatabase'),
        classify: refuse('classify'),
        openDatabase: refuse('openDatabase'),
        migrateDatabase: refuse('migrateDatabase'),
        setJournalModeWal: refuse('setJournalModeWal'),
        closeDatabase: refuse('closeDatabase'),
        importLegacyState: refuse('importLegacyState')
    };
}

const stubPorts = (): AppPorts => ({
    clock: { now: () => 0, monotonicNow: () => 0 },
    notifier: { notify: () => undefined },
    sound: { play: () => undefined },
    bus: { emit: () => undefined },
    scheduler: { every: () => ({ cancel: () => undefined }) }
});

interface Built {
    container: AppContainer;
    lines: string[];
    connection: DatabaseType.Database;
}

async function build(dbPath: string): Promise<Built> {
    const lines: string[] = [];
    const connection = await migratedConnection(dbPath);
    const container = createContainer({
        layer: guardedLayer(),
        connection,
        log: (line) => lines.push(line),
        ports: stubPorts()
    });
    return { container, lines, connection };
}

/** Only what the quit path reads. Nothing on that path touches a repository, which is the point of the flush. */
const stubContainerShape = (): AppContainer => ({
    ports: stubPorts(),
    repositories: {} as AppContainer['repositories'],
    services: {} as AppContainer['services'],
    transaction: (work) => work(),
    dispose: () => undefined
});

const rawCount = (dbPath: string, table: string): number => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return db.prepare<[], { c: number }>('SELECT count(*) AS c FROM ' + table).get()?.c ?? 0;
    } finally {
        db.close();
    }
};

describe('the container hands out repositories over the connection startup opened', () => {
    it('builds all four and reads through them without opening anything itself', async () => {
        const dbPath = makeCleanFixture();
        const { container } = await build(dbPath);

        expect(Object.keys(container.repositories).sort())
            .toEqual(['companies', 'pomodoro', 'sessions', 'settings']);
        expect(container.repositories.sessions.list()).toHaveLength(4);
        expect(container.repositories.companies.list().map((c) => c.name))
            .toEqual(['Contoso Fixture', 'Northwind Fixture', 'Unassigned']);
        expect(container.repositories.settings.get().dailyTargetSeconds).toBeGreaterThan(0);
        expect(container.repositories.pomodoro.countForDay(ld('2026-01-05'))).toBe(0);
    });

    it('wires the timer service over app-state, restored paused and counting nothing yet', async () => {
        const dbPath = makeCleanFixture();
        const { container, connection } = await build(dbPath);

        expect(Object.keys(container.services).sort()).toEqual(['timer']);
        expect(container.services.timer.snapshot())
            .toEqual({ status: 'idle', mode: 'work', elapsedSeconds: 0, restoredFromPreviousLaunch: false });

        // The store writes through app-state.ts, not through a repository and not through raw SQL.
        container.services.timer.setMode('pomodoro');
        expect(realLayer.readTimerState(connection))
            .toEqual({ accumulatedSeconds: 0, mode: 'pomodoro', source: 'persisted' });
    });

    it('flushes the timer on the path that closes the database, before the container is cleared', async () => {
        const dbPath = makeCleanFixture();
        const { container, connection } = await build(dbPath);
        setActiveContainer(container);
        container.services.timer.setMode('pomodoro');

        expect(disposeActiveContainer(), 'a clean dispose must report no failure').toBeNull();
        expect(realLayer.readTimerState(connection).mode).toBe('pomodoro');

        clearActiveContainer();
        expect(disposeActiveContainer(), 'with no container there is nothing to flush').toBeNull();
    });

    it('reports a dispose that could not finish rather than throwing out of the quit path', () => {
        const failing: AppContainer = {
            ...stubContainerShape(),
            dispose: () => { throw new Error('database connection is not open'); }
        };
        setActiveContainer(failing);
        expect(disposeActiveContainer()).toBe('database connection is not open');
        clearActiveContainer();
    });

    it('hands back the ports it was given, and builds the adapters when it is given none', async () => {
        const dbPath = makeCleanFixture();
        const ports = stubPorts();
        const connection = await migratedConnection(dbPath);
        const given = createContainer({ layer: guardedLayer(), connection, log: () => undefined, ports });
        expect(given.ports).toBe(ports);

        const built = createContainer({ layer: guardedLayer(), connection, log: () => undefined });
        expect(Object.keys(built.ports).sort()).toEqual(['bus', 'clock', 'notifier', 'scheduler', 'sound']);
        expect(built.ports.clock.now()).toBeGreaterThan(0);
    });

    it('runs a composition of two repositories in one transaction, and rolls the whole of it back', async () => {
        const dbPath = makeCleanFixture();
        const { container } = await build(dbPath);
        const before = rawCount(dbPath, 'work_sessions');

        expect(() => container.transaction(() => {
            container.repositories.sessions.create({
                name: 'Committed nowhere', durationSeconds: 60, date: ld('2026-01-05'), companyId: null, note: null
            });
            throw new Error('the service changed its mind');
        })).toThrow('the service changed its mind');

        expect(rawCount(dbPath, 'work_sessions'), 'the insert survived a rolled-back transaction').toBe(before);
        container.transaction(() => container.repositories.sessions.create({
            name: 'Committed here', durationSeconds: 60, date: ld('2026-01-05'), companyId: null, note: null
        }));
        expect(rawCount(dbPath, 'work_sessions')).toBe(before + 1);
    });
});

describe('D-15: the skipped-row reporter, which nothing wired until now', () => {
    it('reports every unmappable row by table, column and id, and no stored value', async () => {
        const dbPath = buildLegacyFixture('C', 'anomalies');
        const { container, lines } = await build(dbPath);

        expect(container.repositories.sessions.list(), 'four of the nine rows map').toHaveLength(4);
        expect(lines).toHaveLength(5);
        for (const line of lines) {
            expect(line).toMatch(/^database: work_sessions\.(date|duration), row \d+ was left out of a result - /);
        }
        expect(lines.join('\n'), 'a report must never carry a session name or a note')
            .not.toMatch(/Odd date|Blank date|US date|Fixture task/);
        expect(rawCount(dbPath, 'work_sessions'), 'nothing is repaired and nothing is deleted').toBe(9);
    });

    it('reports a given row once, however often the list is read', async () => {
        const dbPath = buildLegacyFixture('C', 'anomalies');
        const { container, lines } = await build(dbPath);
        container.repositories.sessions.list();
        container.repositories.sessions.list();
        container.repositories.sessions.list();
        expect(lines).toHaveLength(5);
    });

    it('stops reporting past its limit, saying so once, rather than filling the log', () => {
        const lines: string[] = [];
        const report = createSkippedRowReporter((line) => lines.push(line));
        for (let id = 1; id <= SKIPPED_ROW_REPORT_LIMIT + 10; id++) {
            report({ table: 'work_sessions', column: 'date', rowId: id, reason: 'date is not a YYYY-MM-DD local day' });
        }
        expect(lines).toHaveLength(SKIPPED_ROW_REPORT_LIMIT + 1);
        expect(lines.at(-1)).toBe('database: further unreadable rows will not be reported this run (' +
            String(SKIPPED_ROW_REPORT_LIMIT) + ' already were)');
    });

    it('names the table, the column and the row, and an aggregate row that has no id', () => {
        const skipped: SkippedRowReport = {
            table: 'work_sessions', column: 'date', rowId: 7, reason: 'date is not a YYYY-MM-DD local day'
        };
        expect(skippedRowLine(skipped))
            .toBe('database: work_sessions.date, row 7 was left out of a result - date is not a YYYY-MM-DD local day');
        expect(skippedRowLine({ ...skipped, rowId: null })).toContain('no row id');
    });
});

describe('the active container is handed out only while the database is open', () => {
    beforeEach(() => { clearActiveContainer(); });
    afterAll(() => { clearActiveContainer(); });

    it('refuses before one is built and after the database closes', async () => {
        expect(() => activeContainer()).toThrow(/no container is active/);

        const { container } = await build(makeCleanFixture());
        setActiveContainer(container);
        expect(activeContainer()).toBe(container);

        // D-32's will-quit path. The closer is unset in this process, so this is the clear alone.
        closeDatabaseNow();
        expect(() => activeContainer()).toThrow(/no container is active/);
    });
});

/*
 * The wiring inside launchApplication cannot run here - it needs app.getPath - so it is read instead, the way
 * tests/db-startup.test.ts reads the lifecycle handlers. What matters is the order: the container is built after
 * the closer is registered, over the connection startDatabase returned.
 */
describe('ARCH-01: the bootstrap builds exactly one container, after the database is open', () => {
    const source = ts.createSourceFile(LIFECYCLE, read(LIFECYCLE), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const callsTo = (name: string): ts.CallExpression[] => findAll(source, (node): node is ts.CallExpression =>
        ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name);

    it('calls createContainer once, inside setActiveContainer, after registerDatabaseCloser', () => {
        const built = callsTo('createContainer');
        const closer = callsTo('registerDatabaseCloser');
        expect(built, LIFECYCLE + ' no longer builds the container').toHaveLength(1);
        expect(closer, LIFECYCLE + ' no longer registers the database closer (D-32)').toHaveLength(1);
        expect(built[0]?.getStart(source)).toBeGreaterThan(closer[0]?.getStart(source) ?? Infinity);

        const [handedOut] = callsTo('setActiveContainer');
        expect(handedOut, LIFECYCLE + ' builds a container and hands it to nobody').toBeDefined();
        expect(handedOut?.getStart(source) ?? -1).toBeGreaterThan(built[0]?.getStart(source) ?? Infinity);
    });

    it('registers the power handlers once, on the timer of the container it just built', () => {
        const [registered] = callsTo('registerPowerMonitor');
        const [handedOut] = callsTo('setActiveContainer');
        expect(registered, LIFECYCLE + ' no longer gates the timer on suspend (CORE-06)').toBeDefined();
        expect(registered?.getText(source)).toContain('services.timer');
        // After the container is active, so a suspend arriving mid-startup has something to gate.
        expect(registered?.getStart(source) ?? -1).toBeGreaterThan(handedOut?.getStart(source) ?? Infinity);
    });

    it('clears the active container on the path that closes the database', () => {
        expect(callsTo('clearActiveContainer'), LIFECYCLE + ' no longer clears the container at close')
            .toHaveLength(1);
    });
});

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
    GOAL_EVALUATION_INTERVAL_SECONDS, SKIPPED_ROW_REPORT_LIMIT, activeContainer, clearActiveContainer, createContainer,
    createSkippedRowReporter, disposeActiveContainer, setActiveContainer, skippedRowLine
} from '../src/main/container';
import type { AppContainer } from '../src/main/container';
import type { DatabaseLayer } from '../src/main/database-startup';
import { closeDatabaseNow } from '../src/main/lifecycle';
import {
    GOAL_NOTIFICATION, POMODORO_NOT_RECORDED_NOTIFICATION, POMODORO_SESSION_NAME
} from '../src/main/notifications';
import { instantFromEpochMs } from '../src/shared/utils/date';
import type { AppPorts, NotificationRequest } from '../src/main/ports';
import type { IpcEventChannel, SoundId } from '../src/shared/types';
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

// Local noon on a Monday, so the local day is unambiguous in any zone the suite runs in.
const WALL_ORIGIN_MS = new Date(2026, 0, 5, 12, 0, 0).getTime();

// Ten seconds before 23:00:10 on a day the fixture has no sessions on, a fortnight clear of every DST
// transition in the zones this suite runs in, so the only thing that moves across the boundary is the day.
const MIDNIGHT_EVE_MS = new Date(2026, 3, 13, 23, 0, 10).getTime();
const SECONDS_TO_MIDNIGHT = 3590;

// The most one tick may credit - timer.service.ts MAX_CREDIT_MS, pinned at two seconds in timer-service.test.ts.
// Spelled out rather than imported: a test file that names a service module has to stub electron, and this one
// drives the composition root, which imports the Electron adapters on purpose (tests/services-electron-free.test.ts).
const LATE_TICK_MS = 2000;

interface DrivenPorts {
    readonly ports: AppPorts;
    readonly notifications: NotificationRequest[];
    readonly sounds: SoundId[];
    readonly events: IpcEventChannel[];
    /** Advances the monotonic and wall clocks together and runs every scheduled repeat once per whole second. */
    tick(seconds: number): void;
    /** The same at a chosen cadence: MAX_CREDIT_MS is the latest a tick may arrive and still be credited in full. */
    tickEvery(intervalMs: number, times: number): void;
}

/*
 * The container builds its own services, so the only way to drive them is through the ports it was handed. This is
 * the same trick tests/timer-service.test.ts uses: the scheduler is a port precisely so a test can be the clock.
 */
function drivenPorts(wallOriginMs: number = WALL_ORIGIN_MS): DrivenPorts {
    const notifications: NotificationRequest[] = [];
    const sounds: SoundId[] = [];
    const events: IpcEventChannel[] = [];
    const repeats: (() => void)[] = [];
    let monotonic = 0;

    const ports: AppPorts = {
        clock: { now: () => wallOriginMs + monotonic, monotonicNow: () => monotonic },
        notifier: { notify: (request) => notifications.push(request) },
        sound: { play: (sound) => sounds.push(sound) },
        bus: { emit: (channel) => events.push(channel) },
        scheduler: {
            every: (_intervalMs, run) => {
                repeats.push(run);
                return { cancel: () => { const at = repeats.indexOf(run); if (at >= 0) repeats.splice(at, 1); } };
            }
        }
    };

    return {
        ports,
        notifications,
        sounds,
        events,
        tick(seconds) {
            this.tickEvery(1000, seconds);
        },

        tickEvery(intervalMs, times) {
            for (let i = 0; i < times; i++) {
                monotonic += intervalMs;
                for (const run of [...repeats]) run();
            }
        }
    };
}

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

        expect(Object.keys(container.services).sort())
            .toEqual(['companies', 'goal', 'pomodoro', 'sessions', 'settings', 'stats', 'timer']);
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

/*
 * Slices D and E left four services built but unwired: the composition they needed - the goal decision on the tick,
 * and the pomodoro completion's one transaction - is the container's, not theirs. This is that composition, driven
 * through the ports rather than described.
 */
describe('the services the container composes', () => {
    async function driven(dbPath: string): Promise<{ container: AppContainer; driver: DrivenPorts; connection: DatabaseType.Database }> {
        const driver = drivenPorts();
        const connection = await migratedConnection(dbPath);
        const container = createContainer({
            layer: guardedLayer(), connection, log: () => undefined, ports: driver.ports
        });
        return { container, driver, connection };
    }

    it('reaches every service through the repositories it built, over the one connection', async () => {
        const { container } = await driven(makeCleanFixture());
        const company = container.services.companies.create({ name: 'Fabrikam', noteRequired: true });

        expect(() => container.services.sessions.create({
            name: 'No note', durationSeconds: 60, date: ld('2026-01-05'), companyId: company.id, note: null
        }), 'COMP-04: the note-required rule is wired to the real companies repository').toThrow(/requires a note/);

        expect(container.services.settings.get().dailyTargetSeconds).toBeGreaterThan(0);
        expect(container.services.stats.streak().days).toBeGreaterThanOrEqual(0);
        expect(container.services.pomodoro.snapshot().completedToday).toBe(0);
    });

    it('deletes a company and its sessions in one transaction, and says how many went', async () => {
        const dbPath = makeCleanFixture();
        const { container } = await driven(dbPath);
        const [company] = container.services.companies.list();
        expect(company).toBeDefined();

        const attached = container.repositories.sessions.list().filter((s) => s.companyId === company?.id).length;
        expect(attached, 'the fixture must attach sessions to this company, or the count proves nothing')
            .toBeGreaterThan(0);

        const removed = container.services.companies.remove(company?.id ?? 0);
        expect(removed.deletedSessionCount).toBe(attached);
        expect(rawCount(dbPath, 'companies')).toBe(2);
    });

    // POMO-01: the session and the pomodoro row are one write, and they happen before anything asks the user who
    // the work was for. A crash at the prompt therefore loses no time.
    it('writes the work session and the pomodoro row together when an interval completes', async () => {
        const dbPath = makeCleanFixture();
        const { container, driver } = await driven(dbPath);
        container.services.settings.update({ pomodoroWorkSeconds: 60 });
        const sessionsBefore = rawCount(dbPath, 'work_sessions');

        container.services.pomodoro.start();
        driver.tick(59);
        expect(rawCount(dbPath, 'work_sessions'), 'a session was written before the interval finished')
            .toBe(sessionsBefore);

        driver.tick(1);
        expect(rawCount(dbPath, 'work_sessions')).toBe(sessionsBefore + 1);
        expect(rawCount(dbPath, 'pomodoro_sessions')).toBe(1);

        const written = container.repositories.sessions.list()[0];
        expect(written?.name).toBe(POMODORO_SESSION_NAME);
        expect(written?.durationSeconds).toBe(60);
        expect(written?.companyId, 'the attribution prompt is Phase 8\'s; the time is recorded unattributed')
            .toBeNull();

        expect(driver.sounds).toContain('pomodoroCompleted');
        expect(driver.notifications.map((n) => n.title)).toContain('Pomodoro complete');
        expect(driver.events, 'the renderer was never told the cycle changed').toContain('pomodoro:tick');

        // CORE-12: the next interval is derived from what the database now holds, not from a counter.
        expect(container.services.pomodoro.snapshot().completedToday).toBe(1);
        expect(container.services.pomodoro.snapshot().interval).toBe('shortBreak');
    });

    it('rolls both writes back when the pomodoro row cannot be written', async () => {
        const dbPath = makeCleanFixture();
        const driver = drivenPorts();
        const connection = await migratedConnection(dbPath);
        const layer: DatabaseLayer = {
            ...guardedLayer(),
            createPomodoroRepository: (handle, options) => ({
                ...realLayer.createPomodoroRepository(handle, options),
                recordCompletion: () => { throw new Error('disk full'); }
            })
        };
        const container = createContainer({ layer, connection, log: () => undefined, ports: driver.ports });
        container.services.settings.update({ pomodoroWorkSeconds: 60 });
        const before = rawCount(dbPath, 'work_sessions');

        container.services.pomodoro.start();
        driver.tick(60);

        expect(rawCount(dbPath, 'work_sessions'), 'the session survived a failed pomodoro write').toBe(before);
        expect(rawCount(dbPath, 'pomodoro_sessions')).toBe(0);

        /*
         * CR-01: the rollback was always right; what this test used not to ask is what became of the minute it
         * rolled back. Nothing on disk holds it, so the only place it can be is the cycle - held, on the interval
         * that earned it, with the user told rather than a line written to a stdout nobody reads.
         */
        expect(container.services.pomodoro.snapshot()).toMatchObject({
            interval: 'work', status: 'paused', elapsedSeconds: 60, recordingFailed: true
        });
        expect(driver.notifications.map((n) => n.title)).toContain(POMODORO_NOT_RECORDED_NOTIFICATION.title);
    });

    // IN-01: the notifier and the sound run after the transaction commits, so their failure says nothing about
    // whether the interval was recorded - and the one log line a maintainer reads in an incident must not say it did.
    it('reports a refused notification as a refused notification, not as an interval that was lost', async () => {
        const dbPath = makeCleanFixture();
        const driver = drivenPorts();
        const connection = await migratedConnection(dbPath);
        const lines: string[] = [];
        const container = createContainer({
            layer: guardedLayer(),
            connection,
            log: (line) => lines.push(line),
            ports: { ...driver.ports, notifier: { notify: () => { throw new Error('no notification service'); } } }
        });
        container.services.settings.update({ pomodoroWorkSeconds: 60 });
        const sessionsBefore = rawCount(dbPath, 'work_sessions');

        container.services.pomodoro.start();
        driver.tick(60);

        expect(rawCount(dbPath, 'work_sessions'), 'the session the notifier failure had nothing to do with')
            .toBe(sessionsBefore + 1);
        expect(lines.join('\n')).toContain('could not be announced');
        expect(lines.join('\n'), 'a committed interval was reported as unrecorded').not.toContain('could not be recorded');
    });

    /*
     * WR-02. The timer and the pomodoro each own an accumulator and each register their own repeat, and nothing
     * below the composition root can stop both from running. An hour spent in pomodoro mode then produces interval
     * rows AND an hour in the main accumulator the user is prompted to save - two hours recorded for one worked.
     * Inventing time is the same failure as losing it, so the rule is stated and enforced here: at most one
     * accumulator counts at a time. The sum below is the whole assertion - what is on disk plus what is still held
     * must equal the wall clock that passed, never twice it.
     */
    it('counts a pomodoro-mode hour once, whichever accumulator the user started first', async () => {
        const dbPath = makeCleanFixture();
        const { container, driver } = await driven(dbPath);
        container.services.settings.update({ pomodoroWorkSeconds: 1800 });
        const alreadyToday = container.services.stats.today().totalSeconds;

        container.services.timer.start();
        driver.tick(60);
        expect(container.services.timer.snapshot().elapsedSeconds).toBe(60);

        // The user switches to the cycle. The minute already counted is real work and stays savable; from here on
        // the cycle is the one counting.
        container.services.pomodoro.start();
        expect(container.services.timer.snapshot().status, 'both accumulators were left running').toBe('paused');

        driver.tick(1800);

        const written = container.services.stats.today().totalSeconds - alreadyToday;
        const held = container.services.timer.snapshot().elapsedSeconds;
        expect(written, 'the completed interval was not written as a session').toBe(1800);
        expect(held + written, 'WR-02: a 1860-second stretch was recorded as more than 1860 seconds').toBe(1860);
    });

    it('pauses the cycle when the main timer is started, so neither counts the other\'s seconds', async () => {
        const dbPath = makeCleanFixture();
        const { container, driver } = await driven(dbPath);
        container.services.settings.update({ pomodoroWorkSeconds: 1800 });

        container.services.pomodoro.start();
        driver.tick(120);
        container.services.timer.start();
        expect(container.services.pomodoro.snapshot().status, 'both accumulators were left running').toBe('paused');

        driver.tick(60);

        expect(container.services.pomodoro.snapshot().elapsedSeconds, 'the paused cycle went on counting').toBe(120);
        expect(container.services.timer.snapshot().elapsedSeconds).toBe(60);
    });

    /*
     * CORE-13/B1: the decision is made on the timer's own tick - there is no second clock - and it fires once. The
     * day it fired on is in the database, so the next launch of this same fixture does not fire again.
     */
    it('raises the goal notification once, on the tick that reaches the target', async () => {
        const dbPath = makeCleanFixture();
        const { container, driver, connection } = await driven(dbPath);
        // A minute above what the fixture already holds for this local day, so the seconds the running timer is
        // holding are what carries the day over the line - which is the half of CORE-08 a saved-rows-only total misses.
        const alreadyToday = container.services.stats.today().totalSeconds;
        container.services.settings.update({ dailyTargetSeconds: alreadyToday + 60, goalNotification: true });

        container.services.timer.start();
        driver.tick(59);
        expect(driver.notifications, 'the goal fired before the target was reached').toEqual([]);

        driver.tick(1);
        expect(driver.notifications).toEqual([GOAL_NOTIFICATION]);
        expect(driver.sounds).toEqual(['goalReached']);
        expect(realLayer.readGoalNotifiedDate(connection), 'the day it fired on is not in the database')
            .not.toBeNull();

        driver.tick(120);
        expect(driver.notifications, 'B1: the notification fired more than once in a day').toHaveLength(1);
        expect(driver.sounds).toHaveLength(1);
    });

    it('does not raise it at all when the setting is off, and asks only every few seconds', async () => {
        const dbPath = makeCleanFixture();
        const { container, driver } = await driven(dbPath);
        container.services.settings.update({
            dailyTargetSeconds: container.services.stats.today().totalSeconds + 60,
            goalNotification: false
        });

        container.services.timer.start();
        driver.tick(120);
        expect(driver.notifications).toEqual([]);

        // The cadence is a stated cost: a goal met at second 61 is announced at second 70 at the latest.
        expect(GOAL_EVALUATION_INTERVAL_SECONDS).toBeLessThanOrEqual(10);
    });

    /*
     * WR-01. timer.dispose() is the last flush of counted seconds before closeDatabaseNow closes the connection. It
     * used to sit after an unrelated teardown with no isolation, so a throw from the pomodoro's own stop lost up to
     * PERSIST_INTERVAL_MS of work that was already counted - and the database closed immediately afterwards.
     */
    it('flushes the timer even when the pomodoro teardown throws', async () => {
        const driver = drivenPorts();
        const connection = await migratedConnection(makeCleanFixture());
        let breakTheNextCancel = false;
        const ports: AppPorts = {
            ...driver.ports,
            scheduler: {
                every: (intervalMs, run) => {
                    const repeat = driver.ports.scheduler.every(intervalMs, run);
                    const brittle = breakTheNextCancel;
                    return {
                        cancel: () => {
                            repeat.cancel();
                            if (brittle) throw new Error('the notification area went away');
                        }
                    };
                }
            }
        };
        const container = createContainer({
            layer: guardedLayer(), connection, log: () => undefined, ports
        });

        // WR-02 lets one accumulator count at a time, so the cycle is started first and the timer takes over from
        // it. The repeat the timer is then given is the brittle one, and cancelling it is the last thing dispose
        // does - after the flush below has already landed, which is the whole claim.
        container.services.pomodoro.start();
        breakTheNextCancel = true;
        container.services.timer.start();
        // Under PERSIST_INTERVAL_MS, so these three seconds are counted and not yet written.
        driver.tick(3);
        expect(realLayer.readTimerState(connection).accumulatedSeconds, 'the seconds were already on disk').toBe(0);

        setActiveContainer(container);
        expect(disposeActiveContainer(), 'the teardown was expected to throw')
            .toBe('the notification area went away');
        clearActiveContainer();
        expect(realLayer.readTimerState(connection).accumulatedSeconds, 'three counted seconds were lost at quit')
            .toBe(3);
    });

    /*
     * WR-02. persistNow swallowed a write failure, so timer.dispose() could not throw for one, disposeActiveContainer
     * returned null and the quit path reported clean on the one occasion where losing the write is unrecoverable.
     */
    it('reports a final flush that did not land, rather than reporting a clean quit', async () => {
        const driver = drivenPorts();
        const connection = await migratedConnection(makeCleanFixture());
        const attempts: number[] = [];
        const layer: DatabaseLayer = {
            ...guardedLayer(),
            writeTimerState: (_db, state) => {
                attempts.push(state.accumulatedSeconds);
                throw new Error('database or disk is full');
            }
        };
        const lines: string[] = [];
        const container = createContainer({
            layer, connection, log: (line) => lines.push(line), ports: driver.ports
        });

        container.services.timer.start();
        driver.tick(3);
        setActiveContainer(container);

        expect(disposeActiveContainer(), 'a write that never landed was reported as a clean quit')
            .toBe('the elapsed time could not be saved');
        expect(attempts, 'the last flush is worth one retry, and only one').toEqual([3, 3]);
        expect(lines.join('\n')).toContain('timer: the elapsed time could not be saved');
        clearActiveContainer();
    });

    /*
     * WR-03, driven through the real composition root over a real migrated fixture. The user is 49 minutes into a
     * 50-minute interval when Windows restarts. Before this, the next launch started that interval from zero.
     */
    it('gives a second container the interval the first one was holding', async () => {
        const dbPath = makeCleanFixture();
        const connection = await migratedConnection(dbPath);
        const first = drivenPorts();
        const container = createContainer({
            layer: guardedLayer(), connection, log: () => undefined, ports: first.ports
        });
        container.services.settings.update({ pomodoroWorkSeconds: 3000 });

        container.services.pomodoro.start();
        first.tick(2940);
        container.dispose();

        const second = drivenPorts();
        const relaunched = createContainer({
            layer: guardedLayer(), connection, log: () => undefined, ports: second.ports
        });

        expect(relaunched.services.pomodoro.snapshot(), 'forty-nine minutes of real work were dropped at launch')
            .toMatchObject({ interval: 'work', status: 'paused', elapsedSeconds: 2940 });

        // Sixty more seconds finish it, and the session written is the whole interval - not the last minute of it.
        relaunched.services.pomodoro.start();
        second.tick(60);
        expect(relaunched.repositories.sessions.list()[0]?.durationSeconds).toBe(3000);
    });

    it('stops both the timer and the pomodoro when the container is disposed', async () => {
        const { container, driver } = await driven(makeCleanFixture());
        container.services.settings.update({ pomodoroWorkSeconds: 600 });
        // One at a time (WR-02), so each is driven in its turn and both end holding seconds and a live repeat.
        container.services.timer.start();
        driver.tick(5);
        container.services.pomodoro.start();
        driver.tick(5);

        const timerBefore = container.services.timer.snapshot().elapsedSeconds;
        const pomodoroBefore = container.services.pomodoro.snapshot().elapsedSeconds;
        expect(timerBefore, 'the timer never counted, so stopping it proves nothing').toBe(5);
        expect(pomodoroBefore, 'the cycle never counted, so stopping it proves nothing').toBe(5);

        container.dispose();
        driver.tick(30);

        expect(container.services.timer.snapshot().elapsedSeconds).toBe(timerBefore);
        expect(container.services.pomodoro.snapshot().elapsedSeconds).toBe(pomodoroBefore);
    });
});

/*
 * The goal decision, which the shell review found sampling the wrong way and counting the wrong seconds. Every case
 * below is driven through the real createContainer over stub ports and a real migrated fixture, which is how the
 * reviewer reproduced both blockers.
 */
describe('CORE-13: the goal is a fact about the local day, not about the timer', () => {
    interface Driven {
        readonly container: AppContainer;
        readonly driver: DrivenPorts;
        readonly connection: DatabaseType.Database;
    }

    async function driven(options: {
        readonly wallOriginMs?: number;
        /** Seconds a previous launch left unsaved in app_state, as a quit with the timer paused leaves them. */
        readonly carriedSeconds?: number;
    } = {}): Promise<Driven> {
        const connection = await migratedConnection(makeCleanFixture());
        if (options.carriedSeconds !== undefined) {
            realLayer.writeTimerState(
                connection,
                { accumulatedSeconds: options.carriedSeconds, mode: 'work' },
                instantFromEpochMs(options.wallOriginMs ?? WALL_ORIGIN_MS)
            );
        }
        const driver = drivenPorts(options.wallOriginMs);
        const container = createContainer({
            layer: guardedLayer(), connection, log: () => undefined, ports: driver.ports
        });
        return { container, driver, connection };
    }

    /*
     * CR-01. stats.today() is day-scoped and the timer's accumulation is not: it survives a quit, a relaunch and a
     * midnight. Adding the two credited last night's unsaved hours to this morning's goal - and wrote
     * goal.lastNotifiedDate, so the afternoon the user really did reach the target announced nothing.
     */
    it('credits a previous day\'s carried-over seconds to no day at all', async () => {
        const { container, driver, connection } = await driven({ carriedSeconds: 29000 });
        const savedToday = container.services.stats.today().totalSeconds;
        expect(savedToday, 'the fixture must hold a part-day, or the target below proves nothing').toBe(19800);
        container.services.settings.update({ dailyTargetSeconds: savedToday + 3600, goalNotification: true });

        expect(container.services.timer.snapshot(), 'G3/G4: the carry-over is offered, paused')
            .toEqual({ status: 'paused', mode: 'work', elapsedSeconds: 29000, restoredFromPreviousLaunch: true });

        container.services.timer.start();
        driver.tick(60);
        expect(driver.notifications, 'last night announced this morning\'s goal').toEqual([]);
        expect(driver.sounds).toEqual([]);
        expect(realLayer.readGoalNotifiedDate(connection), 'a day nobody worked was written off as notified')
            .toBeNull();

        // B1's other half: the day is still reachable, on the seconds actually worked today.
        driver.tick(3600);
        expect(driver.notifications).toEqual([GOAL_NOTIFICATION]);
        expect(driver.sounds).toEqual(['goalReached']);
    });

    /*
     * The decision the fix report names, stated as a test: seconds belong to the local day they were counted on. A
     * run that crosses midnight starts the new day at zero - the evening's work stays on the evening's day, where
     * the user can still save it, and the new day is reached only on the seconds worked after the boundary.
     */
    it('starts the new day at zero when a running timer crosses midnight', async () => {
        const { container, driver, connection } = await driven({ wallOriginMs: MIDNIGHT_EVE_MS });
        expect(container.services.stats.today().totalSeconds, 'the fixture must hold nothing on either day').toBe(0);
        container.services.settings.update({ dailyTargetSeconds: 3600, goalNotification: true });

        container.services.timer.start();
        driver.tick(SECONDS_TO_MIDNIGHT - 1);
        expect(container.services.stats.today().date).toBe('2026-04-13');
        expect(driver.notifications, 'an hour was announced on an evening only 59 minutes long').toEqual([]);

        // Ten seconds past midnight: the timer holds an hour, and none of it was worked on this day.
        driver.tick(11);
        expect(container.services.stats.today().date).toBe('2026-04-14');
        expect(container.services.timer.snapshot().elapsedSeconds).toBe(SECONDS_TO_MIDNIGHT + 10);
        expect(driver.notifications, 'last night was credited to the new day').toEqual([]);

        driver.tick(3600);
        expect(driver.notifications, 'the new day was not reachable on its own seconds').toEqual([GOAL_NOTIFICATION]);
        expect(realLayer.readGoalNotifiedDate(connection)).toBe('2026-04-14');
    });

    /*
     * CR-02. MAX_CREDIT_MS deliberately lets one tick credit two seconds, so elapsedSeconds is not a counter that
     * lands on every multiple of ten. From an odd second a sustained two-second cadence lands on none of them, and
     * the residue sampler stopped asking for the rest of the day. The tests already here only tick clean seconds,
     * which is why this shipped.
     */
    it('keeps sampling the goal when every tick arrives as late as the clamp allows', async () => {
        const { container, driver } = await driven({ carriedSeconds: 1 });
        const savedToday = container.services.stats.today().totalSeconds;
        container.services.settings.update({ dailyTargetSeconds: savedToday + 20, goalNotification: true });

        container.services.timer.start();
        driver.tickEvery(LATE_TICK_MS, 200);

        expect(container.services.timer.snapshot().elapsedSeconds, 'the clamp stopped crediting two seconds a tick')
            .toBe(401);
        expect(driver.notifications, '381 seconds past the target and nothing fired').toEqual([GOAL_NOTIFICATION]);
        expect(driver.sounds).toEqual(['goalReached']);
    });

    /** The other half of comparing rather than taking a residue: the mark has to rewind when the clock does. */
    it('rewinds the sampler with the timer, so a reset does not silence the rest of the day', async () => {
        const { container, driver } = await driven();
        const today = container.services.stats.today();
        container.services.settings.update({ dailyTargetSeconds: today.totalSeconds + 100, goalNotification: true });

        container.services.timer.start();
        driver.tick(95);
        expect(driver.notifications).toEqual([]);
        container.services.timer.reset();

        // A minute of the day saved by hand, which leaves it forty seconds short of the target.
        container.services.sessions.create({
            name: 'Saved by hand', durationSeconds: 60, date: today.date, companyId: null, note: null
        });
        expect(driver.notifications).toEqual([]);

        container.services.timer.start();
        driver.tick(50);
        expect(driver.notifications, 'the sampler was still waiting for a second the reset clock will never reach')
            .toEqual([GOAL_NOTIFICATION]);
    });

    /*
     * WR-10. A completed pomodoro interval is written as a real session row, which the day's total counts. Adding
     * the main timer's seconds on top while it is in pomodoro mode would count the same wall clock twice.
     */
    it('does not add the main timer to the day while it is in pomodoro mode', async () => {
        const { container, driver } = await driven();
        const savedToday = container.services.stats.today().totalSeconds;
        container.services.settings.update({ dailyTargetSeconds: savedToday + 60, goalNotification: true });

        container.services.timer.setMode('pomodoro');
        container.services.timer.start();
        driver.tick(180);
        expect(driver.notifications, 'the cycle writes its own rows; the main clock must not be added on top')
            .toEqual([]);

        // The same seconds in work mode are the day's own, so the term is scoped rather than dropped.
        container.services.timer.setMode('work');
        driver.tick(10);
        expect(driver.notifications).toEqual([GOAL_NOTIFICATION]);
    });

    /*
     * The services review's WR-01: the decision hung on the main timer's tick, so a day carried over the line by a
     * session written or edited, or by a pomodoro-only day, passed the target in silence.
     */
    it('announces a day carried over the line by a session written or edited, with no timer running', async () => {
        const { container, driver } = await driven();
        const today = container.services.stats.today();
        container.services.settings.update({ dailyTargetSeconds: today.totalSeconds + 600, goalNotification: true });

        const values = {
            name: 'Typed in on History', durationSeconds: 60, date: today.date, companyId: null, note: null
        };
        const created = container.services.sessions.create(values);
        expect(driver.notifications, 'a session nine minutes short announced the day').toEqual([]);

        container.services.sessions.update(created.id, { ...values, durationSeconds: 600 });
        expect(container.services.timer.snapshot().status, 'the main timer must never have run').toBe('idle');
        expect(driver.notifications).toEqual([GOAL_NOTIFICATION]);
        expect(driver.sounds).toEqual(['goalReached']);
    });

    it('announces a pomodoro-only day, where the main timer never runs', async () => {
        const { container, driver } = await driven();
        const savedToday = container.services.stats.today().totalSeconds;
        container.services.settings.update({
            pomodoroWorkSeconds: 60, dailyTargetSeconds: savedToday + 60, goalNotification: true
        });

        container.services.pomodoro.start();
        driver.tick(60);
        expect(container.services.timer.snapshot().status, 'the main timer must never have run').toBe('idle');
        expect(driver.notifications.map((n) => n.title)).toEqual(['Pomodoro complete', 'Daily goal reached']);
        expect(driver.sounds).toEqual(['pomodoroCompleted', 'goalReached']);
    });
});

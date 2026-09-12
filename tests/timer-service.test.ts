// CORE-04..07, CORE-14: the clock the Core Value rests on. Both directions are proved here in one suite - time the
// user did not work is never invented (B12, B13), and time the user did work is never destroyed - because a clamp
// tuned only against invention is a clamp that quietly stops counting.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ipcEvents } from '@shared/ipc/contract';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import { APP_STATE_KEYS, importLegacyState, readAppState, readTimerState, writeTimerState } from '../src/lib/db/app-state';
import {
    GATED_TICK_LIMIT, MAX_CREDIT_MS, PERSIST_INTERVAL_MS, TICK_MS, createTimerService
} from '../src/main/services/timer.service';
import type { PersistedTimerState, TimerService, TimerStateStore } from '../src/main/services/timer.service';
import { instantFromEpochMs } from '../src/shared/utils/date';
import { read } from './helpers/ts-imports';
import type { ClockPort, RendererBusPort, SchedulerPort } from '../src/main/ports';

// Criterion 3: this suite must pass with electron refusing to load.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

const HOUR_MS = 3_600_000;
const SERVICE_FILE = 'src/main/services/timer.service.ts';

interface Emitted {
    channel: string;
    payload: unknown;
}

interface Harness {
    readonly service: TimerService;
    readonly emitted: Emitted[];
    readonly writes: PersistedTimerState[];
    readonly logs: string[];
    /** Moves the monotonic source without firing anything: a frozen, throttled or sleeping process. */
    advance(ms: number): void;
    /** Moves the wall clock alone: a DST step, an NTP correction, a user setting the system clock. */
    skewWallClock(ms: number): void;
    /** Fires the scheduled callback once, if one is scheduled. */
    fire(): void;
    /** advance + fire, `count` times, so a tick that is `stepMs` late is what the service actually sees. */
    drive(count: number, stepMs?: number): void;
    elapsed(): number;
    readonly counters: { scheduled: number; cancelled: number; ticks: number };
}

interface HarnessOptions {
    readonly initial?: PersistedTimerState;
    readonly store?: TimerStateStore;
    /** Monotonic origin. Deliberately not zero: performance.now() is measured from an arbitrary one. */
    readonly originMs?: number;
}

function harness(options: HarnessOptions = {}): Harness {
    let mono = options.originMs ?? 12_345;
    let wallSkew = 0;
    const clock: ClockPort = {
        now: () => 1_757_000_000_000 + mono + wallSkew,
        monotonicNow: () => mono
    };

    const counters = { scheduled: 0, cancelled: 0, ticks: 0 };
    let scheduled: (() => void) | undefined;
    const scheduler: SchedulerPort = {
        every(intervalMs, run) {
            expect(intervalMs, 'the tick interval is the service constant').toBe(TICK_MS);
            counters.scheduled += 1;
            scheduled = run;
            return {
                cancel: () => {
                    counters.cancelled += 1;
                    scheduled = undefined;
                }
            };
        }
    };

    const emitted: Emitted[] = [];
    const bus: RendererBusPort = {
        emit: (channel, payload) => { emitted.push({ channel, payload }); }
    };

    const writes: PersistedTimerState[] = [];
    const logs: string[] = [];
    const inner: TimerStateStore = options.store ?? {
        read: () => options.initial ?? { accumulatedSeconds: 0, mode: 'work' },
        write: () => undefined
    };
    // A separate object, never a mutation of inner: assigning onto the caller's store would make write call itself.
    const store: TimerStateStore = {
        read: () => inner.read(),
        write: (state) => { writes.push(state); inner.write(state); }
    };

    const service = createTimerService({
        clock, scheduler, bus, store, log: (line) => logs.push(line)
    });

    const advance = (ms: number): void => { mono += ms; };
    const skewWallClock = (ms: number): void => { wallSkew += ms; };
    const fire = (): void => {
        if (scheduled !== undefined) {
            counters.ticks += 1;
            scheduled();
        }
    };

    return {
        service, emitted, writes, logs, counters, advance, skewWallClock, fire,
        drive(count, stepMs = TICK_MS) {
            for (let i = 0; i < count; i += 1) {
                advance(stepMs);
                fire();
            }
        },
        elapsed: () => service.snapshot().elapsedSeconds
    };
}

/** A migrated krono.db under mkdtemp. No real profile and no real krono.db is opened anywhere in this file. */
const tempDirs: string[] = [];
const openDatabases: Database.Database[] = [];

afterAll(() => {
    for (const db of openDatabases) closeDatabase(db);
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function migratedDatabase(tag: string): Promise<Database.Database> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-timer-' + tag + '-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'krono.db');
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    const db = openDatabase(dbPath);
    openDatabases.push(db);
    await migrateDatabase(db, {
        dbPath,
        dbClass: classify(probe.observed, LATEST),
        fromVersion: probe.observed.userVersion,
        backupDir: path.join(dir, 'backups')
    });
    return db;
}

/** Exactly what the container wires: the service reaches the database only through app-state.ts. */
function databaseStore(db: Database.Database, at: () => number): TimerStateStore {
    return {
        read: () => {
            const restored = readTimerState(db);
            return { accumulatedSeconds: restored.accumulatedSeconds, mode: restored.mode };
        },
        write: (state) => { writeTimerState(db, state, instantFromEpochMs(at())); }
    };
}

describe('CORE-04: a tick credits a clamped monotonic delta', () => {
    it('counts a normal minute as sixty seconds', () => {
        const h = harness();
        h.service.start();
        h.drive(60);
        expect(h.elapsed()).toBe(60);
    });

    it('credits at most two seconds however long the process was away', () => {
        const h = harness();
        h.service.start();
        h.advance(3 * HOUR_MS);
        h.fire();
        expect(h.elapsed(), 'three hours arrived in one tick and more than the clamp was credited')
            .toBe(MAX_CREDIT_MS / TICK_MS);
    });

    it('ignores the wall clock entirely, in both directions', () => {
        const h = harness();
        h.service.start();
        h.drive(10);

        // An NTP correction, a DST step or a user setting the clock. v1.2.1 measured with exactly this clock.
        h.skewWallClock(HOUR_MS);
        h.drive(1);
        expect(h.elapsed(), 'a forward wall-clock jump was credited as work').toBe(11);

        h.skewWallClock(-2 * HOUR_MS);
        h.drive(1);
        expect(h.elapsed(), 'a backward wall-clock jump destroyed tracked work').toBe(12);
    });

    it('truncates the part-second rather than rounding it up', () => {
        const h = harness();
        h.service.start();
        h.advance(1500);
        h.fire();
        expect(h.elapsed(), 'half a second the user did not work was rounded into existence').toBe(1);
    });

    it('credits nothing at all for a delta that runs backwards', () => {
        const h = harness();
        h.service.start();
        h.drive(10);
        h.advance(-5000);
        h.fire();
        expect(h.elapsed(), 'a backwards delta must neither add nor subtract').toBe(10);
    });

    it('credits nothing while paused or idle, however many ticks are forced', () => {
        const h = harness();
        h.drive(30);
        expect(h.elapsed()).toBe(0);
        expect(h.counters.ticks, 'an idle timer must not have a repeat to fire').toBe(0);

        h.service.start();
        h.drive(10);
        h.service.pause();
        const afterPause = h.elapsed();
        h.drive(30);
        expect(h.elapsed()).toBe(afterPause);
    });

    it('credits the part-second between the last tick and the pause', () => {
        const h = harness();
        h.service.start();
        h.drive(9);
        // A second and a half of real work after the last tick. Dropping it loses up to a second on every pause,
        // and a Pomodoro day is a few dozen pauses.
        h.advance(1500);
        expect(h.service.pause().elapsedSeconds).toBe(10);
    });
});

describe('CORE-05 / B12: time the app was closed for is never added', () => {
    it('resumes a stopped process at the exact second it stopped at, an hour later', async () => {
        const db = await migratedDatabase('closed');

        // Launch one: ten minutes of real work, then the process ends.
        const first = harness({ store: databaseStore(db, () => Date.now()) });
        first.service.start();
        first.drive(600);
        expect(first.elapsed()).toBe(600);
        first.service.dispose();
        expect(readTimerState(db).accumulatedSeconds).toBe(600);

        // Launch two, an hour later, on a fresh monotonic origin - a new process has a new one.
        const second = harness({
            store: databaseStore(db, () => Date.now() + HOUR_MS),
            originMs: 999
        });

        expect(second.elapsed(), 'CORE-05: the hour the app was closed was credited as work').toBe(600);
        expect(second.service.snapshot().status, 'G3/G4: a restored timer must never resume itself').toBe('paused');
        expect(second.service.snapshot().restoredFromPreviousLaunch).toBe(true);
        expect(second.counters.scheduled, 'a restored timer scheduled a tick without the user asking').toBe(0);

        // And starting it continues from there rather than from a recomputed wall-clock difference.
        second.service.start();
        expect(second.elapsed()).toBe(600);
        second.drive(5);
        expect(second.elapsed()).toBe(605);
    });

    it('resumes paused from the v1.2.1 state Phase 4 imported, whatever its running flag said', async () => {
        const db = await migratedDatabase('legacy');
        const savedAWeekAgo = Date.UTC(2026, 8, 5, 9, 0, 0);
        importLegacyState(db, {
            timerState: JSON.stringify({
                elapsed: 3600, running: true, pomodoroMode: false,
                pomodoroState: 'work', pomodoroSessionCount: 0, lastUpdated: savedAWeekAgo
            }),
            lastGoalNotificationDate: null
        }, instantFromEpochMs(Date.UTC(2026, 8, 12, 9, 0, 0)));

        const h = harness({ store: databaseStore(db, () => Date.UTC(2026, 8, 12, 9, 0, 0)) });
        expect(h.elapsed(), 'the week between the v1.2.1 save and this launch was credited').toBe(3600);
        expect(h.service.snapshot().status).toBe('paused');

        h.service.start();
        h.drive(10);
        h.service.pause();
        expect(readTimerState(db)).toEqual({ accumulatedSeconds: 3610, mode: 'work', source: 'persisted' });
        expect(readAppState(db, APP_STATE_KEYS.legacyTimerState)?.elapsedSeconds,
            'the imported v1.2.1 record is evidence and must survive the service writing over it').toBe(3600);
    });

    it('starts at zero, idle and unrestored on a database that has never held a timer', async () => {
        const db = await migratedDatabase('fresh');
        const h = harness({ store: databaseStore(db, () => Date.now()) });
        expect(h.service.snapshot())
            .toEqual({ status: 'idle', mode: 'work', elapsedSeconds: 0, restoredFromPreviousLaunch: false });
    });
});

describe('CORE-06 / B13: time the machine was asleep for is never added', () => {
    it('adds exactly zero across a simulated powerMonitor suspend and resume', () => {
        const h = harness();
        h.service.start();
        h.drive(10);
        expect(h.elapsed()).toBe(10);

        // Windows advances its monotonic source across S3 on some hardware; this is the pessimistic platform.
        h.service.suspend();
        h.advance(HOUR_MS);
        h.service.resume();

        expect(h.elapsed(), 'CORE-06: the hour asleep was credited as work').toBe(10);

        h.drive(5);
        expect(h.elapsed(), 'work after the wake must count normally again').toBe(15);
    });

    it('adds exactly zero on a platform whose monotonic source pauses across the sleep', () => {
        const h = harness();
        h.service.start();
        h.drive(10);

        h.service.suspend();
        h.service.resume();

        expect(h.elapsed()).toBe(10);
        h.drive(5);
        expect(h.elapsed()).toBe(15);
    });

    it('credits nothing for ticks that land while suspended', () => {
        const h = harness();
        h.service.start();
        h.drive(10);

        h.service.suspend();
        h.drive(GATED_TICK_LIMIT - 1);
        expect(h.elapsed(), 'a tick that landed while gated credited work').toBe(10);
    });

    it('lifts the gate on its own when the resume never arrives', () => {
        const h = harness();
        h.service.start();
        h.drive(10);
        h.service.suspend();

        // Ticks landing on schedule mean the process is running and no resume is coming for this suspend.
        h.drive(GATED_TICK_LIMIT);
        expect(h.elapsed(), 'the self-heal must cost at most GATED_TICK_LIMIT ticks').toBe(10);

        h.drive(4);
        expect(h.elapsed(), 'a gate with no resume left the clock stopped for good').toBe(14);
    });

    it('credits the work done up to the suspend, and flushes it', () => {
        const h = harness();
        h.service.start();
        h.drive(9);
        // Half a second of real work between the last tick and the suspend.
        h.advance(500);
        h.service.suspend();
        h.advance(HOUR_MS);
        h.service.resume();
        h.drive(1);
        expect(h.elapsed()).toBe(10);
        expect(h.writes.at(-1)?.accumulatedSeconds, 'suspend must flush before the machine goes down').toBe(9);
    });
});

describe('the other direction: work the user really did is never destroyed', () => {
    it('credits a full hour from ticks that arrive late and irregularly', () => {
        const h = harness();
        h.service.start();

        // Every step is late but inside the clamp: GC, a database write, a stalled event loop.
        const pattern = [1000, 1500, 1900, 1006, 1250];
        let driven = 0;
        let i = 0;
        while (driven < HOUR_MS) {
            const step = Math.min(pattern[i % pattern.length] ?? TICK_MS, HOUR_MS - driven);
            h.advance(step);
            h.fire();
            driven += step;
            i += 1;
        }

        expect(h.elapsed(), 'an hour of real work was under-counted').toBe(3600);
        expect(h.counters.ticks, 'a tick-counting clock would have been right by accident').toBeLessThan(3600);
    });

    it('does not drift when every tick is a few milliseconds late', () => {
        const h = harness();
        h.service.start();
        // v1.2.1 counted ticks in some places; at 1006 ms per tick that loses about twenty seconds an hour.
        h.drive(3000, 1006);
        expect(h.elapsed()).toBe(Math.floor((3000 * 1006) / TICK_MS));
    });

    it('records what a tick later than the clamp costs, because that is the price of the guarantee', () => {
        const h = harness();
        h.service.start();
        // A renderer-owned tick throttled to once a minute would look like this. It is why the clock is in main.
        h.drive(10, 60_000);
        expect(h.elapsed()).toBe(10 * (MAX_CREDIT_MS / TICK_MS));
    });
});

describe('CORE-14 / CB-1: a mode change never resets accumulated time', () => {
    it('keeps the seconds and the status across a change in either direction', () => {
        const h = harness();
        h.service.start();
        h.drive(30);
        h.service.pause();

        expect(h.service.setMode('pomodoro'))
            .toEqual({ status: 'paused', mode: 'pomodoro', elapsedSeconds: 30, restoredFromPreviousLaunch: false });
        expect(h.service.setMode('work').elapsedSeconds, 'switching back discarded what was counted').toBe(30);
    });

    it('keeps a running timer running, and keeps counting through the change', () => {
        const h = harness();
        h.service.start();
        h.drive(30);

        h.service.setMode('pomodoro');
        expect(h.service.snapshot().status).toBe('running');
        expect(h.counters.cancelled, 'the mode change stopped the tick').toBe(0);

        h.drive(10);
        expect(h.elapsed()).toBe(40);
    });

    it('carries the mode across a restart with its seconds', async () => {
        const db = await migratedDatabase('mode-restart');
        const first = harness({ store: databaseStore(db, () => Date.now()) });
        first.service.start();
        first.drive(45);
        first.service.setMode('pomodoro');
        first.service.dispose();

        const second = harness({ store: databaseStore(db, () => Date.now()) });
        expect(second.service.snapshot().mode).toBe('pomodoro');
        expect(second.elapsed()).toBe(45);
    });

    it('leaves reset as the only path that discards time', () => {
        const h = harness();
        h.service.start();
        h.drive(30);

        expect(h.service.reset())
            .toEqual({ status: 'idle', mode: 'work', elapsedSeconds: 0, restoredFromPreviousLaunch: false });
        expect(h.counters.cancelled, 'reset left the repeat running').toBe(1);
        expect(h.writes.at(-1)).toEqual({ accumulatedSeconds: 0, mode: 'work' });
    });
});

describe('CORE-07: what is persisted is a scalar, and how often', () => {
    it('writes seconds and mode, and nothing that could be subtracted from a clock', () => {
        const h = harness();
        h.service.start();
        h.drive(30);
        h.service.pause();

        expect(h.writes.length).toBeGreaterThan(0);
        for (const write of h.writes) {
            expect(Object.keys(write).sort()).toEqual(['accumulatedSeconds', 'mode']);
        }
        expect(h.writes.at(-1)?.accumulatedSeconds).toBe(30);
    });

    it('writes on the debounce while running rather than once a second', () => {
        const h = harness();
        h.service.start();
        h.drive(12);
        // Twelve seconds of ticks at a five-second debounce: two flushes. start wrote nothing because nothing
        // had changed - only what is counted is persisted, so an idle-to-running transition is not a write.
        expect(h.writes.map((w) => w.accumulatedSeconds)).toEqual([5, 10]);
        expect(PERSIST_INTERVAL_MS).toBe(5000);
    });

    it('flushes immediately on pause, on a mode change and on dispose', () => {
        const h = harness();
        h.service.start();
        h.drive(2);
        h.service.pause();
        expect(h.writes.at(-1)?.accumulatedSeconds).toBe(2);

        h.service.setMode('pomodoro');
        expect(h.writes.at(-1)).toEqual({ accumulatedSeconds: 2, mode: 'pomodoro' });

        h.service.start();
        h.drive(3);
        h.service.dispose();
        expect(h.writes.at(-1)?.accumulatedSeconds).toBe(5);
        // One for the pause above, one for the dispose: both stop the repeat they were holding.
        expect(h.counters.cancelled, 'dispose left the repeat running').toBe(2);
    });

    it('reports a failed write and keeps counting, because the value is still in memory', () => {
        const h = harness({
            store: {
                read: () => ({ accumulatedSeconds: 0, mode: 'work' }),
                write: () => { throw new Error('database or disk is full'); }
            }
        });
        h.service.start();
        expect(() => { h.drive(12); }).not.toThrow();
        expect(h.elapsed()).toBe(12);
        expect(h.logs.some((line) => line.startsWith('timer: the elapsed time could not be saved'))).toBe(true);
    });

    it('loses at most the debounce when the process is killed while running', async () => {
        const db = await migratedDatabase('killed');
        const first = harness({ store: databaseStore(db, () => Date.now()) });
        first.service.start();
        first.drive(12);
        // No dispose: the process was killed.

        const second = harness({ store: databaseStore(db, () => Date.now()) });
        expect(first.elapsed() - second.elapsed()).toBeLessThanOrEqual(PERSIST_INTERVAL_MS / TICK_MS);
        expect(second.elapsed(), 'the last flush before the kill was at ten seconds').toBe(10);
    });
});

describe('the tick the renderer mirrors', () => {
    it('emits a payload the declared event schema accepts, on every state change', () => {
        const h = harness();
        h.service.start();
        h.drive(3);
        h.service.pause();
        h.service.setMode('pomodoro');
        h.service.reset();

        expect(h.emitted.length).toBeGreaterThan(3);
        for (const { channel, payload } of h.emitted) {
            expect(channel).toBe('timer:tick');
            expect(ipcEvents['timer:tick'].safeParse(payload).success,
                'an emitted snapshot did not satisfy the contract it is declared under').toBe(true);
        }
    });

    it('emits once per tick and no more', () => {
        const h = harness();
        h.service.start();
        const afterStart = h.emitted.length;
        h.drive(7);
        expect(h.emitted.length - afterStart).toBe(7);
    });

    it('does nothing at all when start or pause is called twice', () => {
        const h = harness();
        h.service.start();
        const emits = h.emitted.length;
        h.service.start();
        expect(h.emitted.length, 'a second start re-emitted or re-scheduled').toBe(emits);
        expect(h.counters.scheduled).toBe(1);

        h.service.pause();
        const paused = h.emitted.length;
        h.service.pause();
        expect(h.emitted.length).toBe(paused);
        expect(h.counters.cancelled).toBe(1);
    });
});

describe('the service reads time only through the clock port', () => {
    const source = read(SERVICE_FILE);

    it.each([
        ['Date.now(', 'the wall clock a system-clock change moves'],
        ['performance.now(', 'the monotonic source, which belongs to the adapter'],
        ['new Date(', 'a wall-clock instant'],
        ['setInterval(', 'a repeat the scheduler port owns'],
        ['setTimeout(', 'a repeat the scheduler port owns'],
        ['startTime', 'the field B12 and B13 were both computed from']
    ])('never names %s (%s)', (needle) => {
        expect(source.includes(needle), SERVICE_FILE + ' names ' + needle).toBe(false);
    });

    it('takes every input it needs as a port or a store', () => {
        expect(source).toContain("from '../ports'");
        expect(source).not.toContain("from '../lib/db");
        expect(source).not.toContain("from 'electron'");
    });
});

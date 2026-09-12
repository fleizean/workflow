// CORE-11/CORE-12: the pomodoro cycle. The load-bearing claim is that the long-break counter is not a variable -
// it is a question asked of the database - so the tests that matter are the ones an in-memory counter would fail:
// a caller that records nothing sees no count, an abort advances nothing, and a second service over the same
// database resumes the cycle exactly where the first one left it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import { createDbHandle } from '../src/lib/db/handle';
import { createPomodoroRepository } from '../src/lib/db/repositories/pomodoro.repository';
import { TICK_MS } from '../src/main/services/timer.service';
import { createPomodoroService } from '../src/main/services/pomodoro.service';
import type {
    PomodoroCompletion, PomodoroDurations, PomodoroLedger, PomodoroService, PomodoroSnapshot
} from '../src/main/services/pomodoro.service';
import { addDays, formatLocalDate, instantFromEpochMs, parseLocalDate } from '../src/shared/utils/date';
import { read } from './helpers/ts-imports';
import type { ClockPort, SchedulerPort } from '../src/main/ports';
import type { LocalDate } from '../src/shared/types';

// Criterion 3: this suite must pass with electron refusing to load.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

const SERVICE_FILE = 'src/main/services/pomodoro.service.ts';
const HOUR_MS = 3_600_000;
// A Saturday at 09:00 local, wherever this runs. Nothing below depends on which day of the week it is.
const WALL_ORIGIN_MS = Date.UTC(2026, 8, 12, 9, 0, 0);

const WORK = 1500;
const SHORT = 300;
const LONG = 900;

const FAST: PomodoroDurations = {
    workSeconds: WORK, shortBreakSeconds: SHORT, longBreakSeconds: LONG, sessionsUntilLongBreak: 4
};

/** A ledger backed by rows, so countForDay is a real derivation and never a number the test kept. */
interface RecordingLedger extends PomodoroLedger {
    readonly rows: LocalDate[];
    add(date: LocalDate): void;
}

function rowLedger(initial: LocalDate[] = []): RecordingLedger {
    const rows = [...initial];
    return {
        rows,
        add: (date) => { rows.push(date); },
        countForDay: (date) => rows.filter((row) => row === date).length
    };
}

interface HarnessOptions {
    readonly ledger?: RecordingLedger;
    readonly durations?: Partial<PomodoroDurations>;
    /** What onCompleted does. The default records a work completion, as POMO-01's transaction will. */
    readonly onCompleted?: (completion: PomodoroCompletion, ledger: RecordingLedger) => void;
    readonly originMs?: number;
    readonly wallOriginMs?: number;
}

interface Harness {
    readonly service: PomodoroService;
    readonly ledger: RecordingLedger;
    readonly completions: PomodoroCompletion[];
    readonly changes: PomodoroSnapshot[];
    readonly logs: string[];
    readonly counters: { scheduled: number; cancelled: number; ticks: number; reads: number };
    setDurations(next: Partial<PomodoroDurations>): void;
    advance(ms: number): void;
    advanceWallClock(ms: number): void;
    fire(): void;
    drive(count: number, stepMs?: number): void;
    /** advance + fire until the interval this call started on is over, or the budget runs out. */
    runOut(): void;
    snapshot(): PomodoroSnapshot;
}

function harness(options: HarnessOptions = {}): Harness {
    let mono = options.originMs ?? 987_654;
    let wall = options.wallOriginMs ?? WALL_ORIGIN_MS;
    const clock: ClockPort = {
        // The wall clock names the day and never measures an interval; the two move independently on purpose.
        now: () => wall,
        monotonicNow: () => mono
    };

    const counters = { scheduled: 0, cancelled: 0, ticks: 0, reads: 0 };
    let scheduled: (() => void) | undefined;
    const scheduler: SchedulerPort = {
        every(intervalMs, run) {
            expect(intervalMs, 'the tick interval is the timer service constant').toBe(TICK_MS);
            counters.scheduled += 1;
            scheduled = run;
            return { cancel: () => { counters.cancelled += 1; scheduled = undefined; } };
        }
    };

    const backing = options.ledger ?? rowLedger();
    const ledger: RecordingLedger = {
        rows: backing.rows,
        add: (date) => { backing.add(date); },
        countForDay: (date) => { counters.reads += 1; return backing.countForDay(date); }
    };

    let durations: PomodoroDurations = { ...FAST, ...options.durations };
    const completions: PomodoroCompletion[] = [];
    const changes: PomodoroSnapshot[] = [];
    const logs: string[] = [];

    const record = options.onCompleted ?? ((completion, target) => {
        if (completion.interval === 'work') target.add(completion.date);
    });

    const service = createPomodoroService({
        clock,
        scheduler,
        ledger,
        durations: () => durations,
        onCompleted: (completion) => { completions.push(completion); record(completion, ledger); },
        onChanged: (snapshot) => { changes.push(snapshot); },
        log: (line) => logs.push(line)
    });

    const advance = (ms: number): void => { mono += ms; wall += ms; };
    const fire = (): void => {
        if (scheduled !== undefined) {
            counters.ticks += 1;
            scheduled();
        }
    };
    const drive = (count: number, stepMs: number = TICK_MS): void => {
        for (let i = 0; i < count; i += 1) {
            advance(stepMs);
            fire();
        }
    };

    return {
        service, ledger, completions, changes, logs, counters, advance, fire, drive,
        setDurations: (next) => { durations = { ...durations, ...next }; },
        advanceWallClock: (ms) => { wall += ms; },
        runOut() {
            const before = completions.length;
            for (let i = 0; i < 20_000 && completions.length === before; i += 1) {
                advance(TICK_MS);
                fire();
            }
            expect(completions.length, 'the interval never reached its target').toBeGreaterThan(before);
        },
        snapshot: () => service.snapshot()
    };
}

/** The local day the harness's wall clock starts on, computed by the one sanctioned date module. */
const originDay = (): LocalDate => formatLocalDate(instantFromEpochMs(WALL_ORIGIN_MS));

describe('CORE-11: the cycle is work, break, work', () => {
    it('starts idle on a work interval whose target is the work duration', () => {
        const h = harness();
        expect(h.snapshot()).toMatchObject({
            interval: 'work', status: 'idle', elapsedSeconds: 0, targetSeconds: WORK, remainingSeconds: WORK
        });
    });

    it('counts toward the target while running and reports what is left', () => {
        const h = harness();
        h.service.start();
        h.drive(90);
        expect(h.snapshot()).toMatchObject({ elapsedSeconds: 90, remainingSeconds: WORK - 90, status: 'running' });
    });

    it('moves to a short break when the first work interval reaches its target', () => {
        const h = harness();
        h.service.start();
        h.runOut();
        expect(h.snapshot()).toMatchObject({ interval: 'shortBreak', status: 'idle', elapsedSeconds: 0 });
        expect(h.snapshot().targetSeconds, 'the break is timed by its own duration').toBe(SHORT);
    });

    it('returns to work when a break reaches its target, recording no pomodoro for it', () => {
        const h = harness();
        h.service.start();
        h.runOut();
        h.service.start();
        h.runOut();
        expect(h.snapshot().interval).toBe('work');
        expect(h.ledger.rows.length, 'a break was counted as a pomodoro').toBe(1);
        expect(h.completions.map((c) => c.interval)).toEqual(['work', 'shortBreak']);
    });

    it('reaches the long break on the fourth pomodoro of the day and not before', () => {
        const h = harness();
        const seen: string[] = [];
        for (let i = 0; i < 4; i += 1) {
            h.service.start();
            h.runOut();
            seen.push(h.snapshot().interval);
            // Sit out the break so the next work interval starts clean.
            h.service.start();
            h.runOut();
        }
        expect(seen).toEqual(['shortBreak', 'shortBreak', 'shortBreak', 'longBreak']);
    });

    it('gives a long break after every pomodoro when the cycle length is one', () => {
        const h = harness({ durations: { sessionsUntilLongBreak: 1 } });
        h.service.start();
        h.runOut();
        expect(h.snapshot().interval).toBe('longBreak');
    });

    it('pauses and resumes without losing what was counted', () => {
        const h = harness();
        h.service.start();
        h.drive(30);
        h.advance(400);
        h.service.pause();
        expect(h.snapshot(), 'the part-second since the last tick was dropped')
            .toMatchObject({ status: 'paused', elapsedSeconds: 30 });

        h.advance(2 * HOUR_MS);
        h.service.start();
        h.drive(10);
        expect(h.snapshot().elapsedSeconds, 'two paused hours were credited to the interval').toBe(40);
    });

    it('credits the part-second a pause would otherwise discard', () => {
        const h = harness();
        h.service.start();
        h.drive(30);
        h.advance(900);
        h.service.pause();
        h.service.start();
        h.advance(200);
        h.fire();
        // 30.9s + 0.2s. A pause that dropped the 900 ms would report 30, and a break every 25 minutes would
        // quietly lose most of a second each time.
        expect(h.snapshot().elapsedSeconds).toBe(31);
    });

    it('stops the repeat when the interval ends, so nothing ticks between intervals', () => {
        const h = harness();
        h.service.start();
        h.runOut();
        expect(h.counters.scheduled).toBe(1);
        expect(h.counters.cancelled).toBe(1);
    });

    it('takes a duration changed mid-interval into account immediately (POMO-06)', () => {
        const h = harness();
        h.service.start();
        h.drive(100);
        h.setDurations({ workSeconds: 120 });
        expect(h.snapshot().remainingSeconds).toBe(20);
        h.drive(20);
        expect(h.completions.map((c) => c.interval)).toEqual(['work']);
    });

    it('falls back to the shipped seed rather than looping on a nonsensical duration', () => {
        const h = harness({ durations: { workSeconds: 0 } });
        expect(h.snapshot().targetSeconds).toBe(DEFAULT_SETTINGS.pomodoroWorkSeconds);
    });

    it('falls back rather than dividing by a zero cycle length', () => {
        const h = harness({ durations: { sessionsUntilLongBreak: 0 } });
        expect(h.snapshot().sessionsUntilLongBreak).toBe(DEFAULT_SETTINGS.pomodoroSessionsUntilLongBreak);
        h.service.start();
        h.runOut();
        expect(h.snapshot().interval, 'a NaN cycle length picked the break').toBe('shortBreak');
    });
});

describe('CORE-11: the interval is measured, never read off the wall clock', () => {
    it('credits at most two seconds however long the process was away', () => {
        const h = harness();
        h.service.start();
        h.advance(3 * HOUR_MS);
        h.fire();
        // Three hours of sleep must not finish a 25-minute pomodoro nobody worked.
        expect(h.snapshot().elapsedSeconds).toBe(2);
        expect(h.completions, 'a sleeping machine completed a pomodoro').toEqual([]);
    });

    it('ignores a wall-clock jump in both directions', () => {
        const h = harness();
        h.service.start();
        h.drive(10);
        h.advanceWallClock(HOUR_MS);
        h.drive(1);
        h.advanceWallClock(-2 * HOUR_MS);
        h.drive(1);
        expect(h.snapshot().elapsedSeconds).toBe(12);
    });

    it('records at least the target and no more than one clamped tick over it', () => {
        const h = harness({ durations: { workSeconds: 60 } });
        h.service.start();
        h.drive(59);
        h.advance(1900);
        h.fire();
        const [completion] = h.completions;
        expect(completion?.elapsedSeconds, 'the surplus is real work and is not discarded')
            .toBeGreaterThanOrEqual(60);
        expect(completion?.elapsedSeconds).toBeLessThanOrEqual(62);
    });
});

describe('CORE-12: the long-break counter is derived, not held', () => {
    it('reports whatever the database holds for today, including work it never saw', () => {
        const day = originDay();
        const h = harness({ ledger: rowLedger([day, day, day]) });
        expect(h.snapshot().completedToday).toBe(3);
    });

    it('does not move the count when the caller records nothing', () => {
        // The test that an in-memory counter cannot pass: four completions, nothing written, so nothing counted.
        const h = harness({ onCompleted: () => undefined });
        for (let i = 0; i < 4; i += 1) {
            h.service.start();
            h.runOut();
            h.service.start();
            h.runOut();
        }
        expect(h.completions.filter((c) => c.interval === 'work')).toHaveLength(4);
        expect(h.snapshot().completedToday, 'the service counted completions of its own').toBe(0);
        expect(h.snapshot().interval, 'a self-counted fourth pomodoro picked the long break').toBe('work');
    });

    it('does not advance on an aborted work interval, however close to the target it was', () => {
        const day = originDay();
        const h = harness({ ledger: rowLedger([day, day, day]), durations: { workSeconds: 60 } });
        h.service.start();
        h.drive(59);
        h.service.abort();

        expect(h.completions, 'an abandoned interval was reported as completed').toEqual([]);
        expect(h.ledger.rows).toHaveLength(3);
        expect(h.snapshot()).toMatchObject({ interval: 'work', status: 'idle', elapsedSeconds: 0, completedToday: 3 });

        // And the cycle is still where it was: the next genuine completion is the fourth, so the long break is due.
        h.service.start();
        h.runOut();
        expect(h.snapshot().interval).toBe('longBreak');
    });

    it('does not advance on an aborted break either, and still owes that break', () => {
        const h = harness();
        h.service.start();
        h.runOut();
        h.service.start();
        h.drive(10);
        h.service.abort();
        expect(h.snapshot(), 'an abandoned break was skipped rather than abandoned')
            .toMatchObject({ interval: 'shortBreak', elapsedSeconds: 0, completedToday: 1 });
    });

    it('resumes the cycle after a restart, because the restart remembers nothing', () => {
        const day = originDay();
        const ledger = rowLedger([day, day, day]);

        // A second service over the same rows: a new process, a new monotonic origin, no memory of the first.
        const second = harness({ ledger, originMs: 42 });
        expect(second.snapshot().completedToday).toBe(3);
        second.service.start();
        second.runOut();
        expect(second.snapshot().interval, 'the restart reset the cycle to zero').toBe('longBreak');
    });

    it('picks up a row another part of the app wrote, without being told', () => {
        const day = originDay();
        const h = harness();
        expect(h.snapshot().completedToday).toBe(0);
        h.ledger.add(day);
        h.ledger.add(day);
        h.service.start();
        expect(h.snapshot().completedToday).toBe(2);
    });

    it('skipping a break records nothing and moves the cycle no further', () => {
        const h = harness();
        h.service.start();
        h.runOut();
        h.service.skipBreak();
        expect(h.snapshot()).toMatchObject({ interval: 'work', status: 'idle', completedToday: 1 });
        expect(h.completions.map((c) => c.interval), 'a skipped break was reported as completed').toEqual(['work']);
    });

    it('refuses to skip a work interval, which is not a break', () => {
        const h = harness();
        h.service.start();
        h.drive(10);
        h.service.skipBreak();
        expect(h.snapshot()).toMatchObject({ interval: 'work', status: 'running', elapsedSeconds: 10 });
    });

    it('never writes the count from arithmetic of its own', () => {
        // Structural, because the behavioural tests above can only catch the mistakes someone thought to make.
        const source = read(SERVICE_FILE);
        for (const forbidden of ['completedToday +=', 'completedToday++', 'completedToday + 1', 'completedToday -']) {
            expect(source.includes(forbidden), SERVICE_FILE + ' computes the count: ' + forbidden).toBe(false);
        }
        // Exactly one assignment is not a literal zero, and it is the ledger read.
        const fromLedger = source.match(/completedToday = Math\.max\(0, ledger\.countForDay\(/g) ?? [];
        expect(fromLedger).toHaveLength(1);
        const substantive = source.match(/completedToday = (?!0;)/g) ?? [];
        expect(substantive.length, 'the count is given a value by something other than the ledger').toBe(1);
    });
});

describe('CORE-12: the day a pomodoro belongs to is a local day', () => {
    it('re-reads the count for the new day when local midnight passes mid-interval', () => {
        const start = WALL_ORIGIN_MS;
        const today = formatLocalDate(instantFromEpochMs(start));
        const tomorrow = addDays(today, 1);
        // The exact distance to the next local midnight, from the one sanctioned date module.
        const toMidnight = parseLocalDate(tomorrow).getTime() - start;

        const ledger = rowLedger([today, today, today, tomorrow]);
        const h = harness({ ledger, durations: { workSeconds: 86_400 } });
        h.service.start();
        expect(h.snapshot()).toMatchObject({ date: today, completedToday: 3 });

        h.advance(toMidnight + TICK_MS);
        h.fire();
        expect(h.snapshot(), 'the cycle carried yesterday\'s count into today')
            .toMatchObject({ date: tomorrow, completedToday: 1 });
    });

    it('records a work interval on the day it finished, not the day it started', () => {
        const start = WALL_ORIGIN_MS;
        const today = formatLocalDate(instantFromEpochMs(start));
        const tomorrow = addDays(today, 1);
        const toMidnight = parseLocalDate(tomorrow).getTime() - start;

        const h = harness({ durations: { workSeconds: 86_400 } });
        h.service.start();
        h.advance(toMidnight + TICK_MS);
        h.fire();
        h.setDurations({ workSeconds: 1 });
        h.drive(1);

        expect(h.completions[0]?.date).toBe(tomorrow);
        expect(h.ledger.rows).toEqual([tomorrow]);
    });
});

describe('CORE-11: a failure below is reported, never thrown at the user', () => {
    it('keeps ticking when the ledger read throws, and says so once it can', () => {
        const day = originDay();
        const ledger = rowLedger([day]);
        let failing = true;
        const h = harness({
            ledger: {
                rows: ledger.rows,
                add: (date) => { ledger.add(date); },
                countForDay: (date) => {
                    if (failing) throw new Error('database is locked');
                    return ledger.countForDay(date);
                }
            }
        });

        expect(h.snapshot().completedToday, 'a failed read invented a count').toBe(0);
        expect(h.logs.join(' ')).toContain('database is locked');

        failing = false;
        h.service.start();
        h.drive(5);
        expect(h.snapshot(), 'the cycle stopped counting after a failed read')
            .toMatchObject({ completedToday: 1, elapsedSeconds: 5 });
    });

    it('leaves the completed interval behind even when recording it throws', () => {
        const h = harness({
            durations: { workSeconds: 60 },
            onCompleted: () => { throw new Error('disk is full'); }
        });
        h.service.start();
        h.runOut();
        expect(h.logs.join(' ')).toContain('disk is full');
        // Staying on a finished work interval would go on counting time already accounted for.
        expect(h.snapshot()).toMatchObject({ interval: 'shortBreak', status: 'idle', elapsedSeconds: 0 });
    });
});

describe('CORE-11: every change is published', () => {
    it('publishes a snapshot on each tick and on each command', () => {
        const h = harness();
        h.service.start();
        h.drive(3);
        h.service.pause();
        expect(h.changes).toHaveLength(5);
        expect(h.changes.at(-1)).toMatchObject({ status: 'paused', elapsedSeconds: 3 });
    });

    it('publishes the interval the completion moved to, not the one that ended', () => {
        const h = harness({ durations: { workSeconds: 1 } });
        h.service.start();
        h.drive(1);
        expect(h.changes.at(-1)).toMatchObject({ interval: 'shortBreak', completedToday: 1 });
    });
});

/** A migrated krono.db under mkdtemp. No real profile and no real krono.db is opened anywhere in this file. */
const tempDirs: string[] = [];
const openDatabases: Database.Database[] = [];

afterAll(() => {
    for (const db of openDatabases) closeDatabase(db);
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function migratedDatabase(tag: string): Promise<Database.Database> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-pomodoro-' + tag + '-'));
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

describe('CORE-12: the counter over the real pomodoro repository', () => {
    /** Exactly what the container will wire: countForDay in, recordCompletion out. */
    function serviceOver(db: Database.Database, originMs: number): Harness {
        const repository = createPomodoroRepository(createDbHandle(db));
        return harness({
            originMs,
            ledger: {
                rows: [],
                add: (date) => { repository.recordCompletion(date, null); },
                countForDay: (date) => repository.countForDay(date)
            },
            durations: { workSeconds: 2 }
        });
    }

    it('walks four pomodoros to the long break, with four rows on today', async () => {
        const db = await migratedDatabase('cycle');
        const h = serviceOver(db, 1000);
        const seen: string[] = [];
        for (let i = 0; i < 4; i += 1) {
            h.service.start();
            h.runOut();
            seen.push(h.snapshot().interval);
            h.service.skipBreak();
        }
        expect(seen).toEqual(['shortBreak', 'shortBreak', 'shortBreak', 'longBreak']);

        const repository = createPomodoroRepository(createDbHandle(db));
        expect(repository.countForDay(originDay())).toBe(4);
    });

    it('resumes the cycle across a restart, and an abort in between changes nothing', async () => {
        const db = await migratedDatabase('restart');

        const first = serviceOver(db, 1000);
        for (let i = 0; i < 2; i += 1) {
            first.service.start();
            first.runOut();
            first.service.skipBreak();
        }
        first.service.dispose();

        // A new process: a new service, a new monotonic origin, nothing carried over but the database.
        const second = serviceOver(db, 7_777_777);
        expect(second.snapshot().completedToday).toBe(2);

        second.service.start();
        second.drive(1);
        second.service.abort();
        expect(second.snapshot().completedToday, 'the abort wrote a row').toBe(2);

        second.service.start();
        second.runOut();
        expect(second.snapshot().interval, 'the third pomodoro of the day took the long break').toBe('shortBreak');
        second.service.skipBreak();

        second.service.start();
        second.runOut();
        expect(second.snapshot().interval, 'the fourth pomodoro of the day did not take the long break')
            .toBe('longBreak');
        second.service.dispose();
    });

    it('counts only today, so an earlier day counts for nothing today', async () => {
        const db = await migratedDatabase('yesterday');
        const repository = createPomodoroRepository(createDbHandle(db));
        const yesterday = addDays(originDay(), -1);
        for (let i = 0; i < 3; i += 1) repository.recordCompletion(yesterday, null);

        const h = serviceOver(db, 1000);
        expect(h.snapshot().completedToday).toBe(0);
        h.service.start();
        h.runOut();
        expect(h.snapshot().interval).toBe('shortBreak');
    });
});

describe('CORE-02: the cycle names no clock and no Electron of its own', () => {
    const source = read(SERVICE_FILE);

    it.each([
        ['Date.now(', 'the wall clock a system-clock change moves'],
        ['performance.now(', 'the monotonic source, which belongs to the adapter'],
        ['new Date(', 'a wall-clock instant'],
        ['setInterval(', 'a repeat the scheduler port owns'],
        ['setTimeout(', 'a repeat the scheduler port owns']
    ])('never names %s (%s)', (needle) => {
        expect(source.includes(needle), SERVICE_FILE + ' names ' + needle).toBe(false);
    });

    it('takes every input it needs as a port, a ledger or a callback', () => {
        expect(source).toContain("from '../ports'");
        expect(source).not.toContain("from '../lib/db");
        expect(source).not.toContain("from 'electron'");
    });

    it('shares the timer service clamp rather than restating one', () => {
        expect(source).toContain("from './timer.service'");
        expect(source).toContain('creditableMs');
    });
});

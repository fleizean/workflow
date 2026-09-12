// CORE-13, B1: the daily-goal notification fires at most once per local day, and the day it fired on outlives the
// process. The real database is in this suite because the guarantee is about a restart, and a restart is exactly
// what an in-memory flag cannot survive - which is the half of B1 v1.2.1 got wrong.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import { importLegacyState, readGoalNotifiedDate, writeGoalNotifiedDate } from '../src/lib/db/app-state';
import { createGoalService, decideGoalNotification } from '../src/main/services/goal.service';
import type { GoalNotificationStore, GoalService, GoalSettings } from '../src/main/services/goal.service';
import { addDays, formatLocalDate, instantFromEpochMs, parseLocalDate } from '../src/shared/utils/date';
import { read } from './helpers/ts-imports';
import type { ClockPort } from '../src/main/ports';
import type { LocalDate } from '../src/shared/types';

// Criterion 3: this suite must pass with electron refusing to load.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

const SERVICE_FILE = 'src/main/services/goal.service.ts';
const WALL_ORIGIN_MS = Date.UTC(2026, 8, 12, 9, 0, 0);
const TARGET = 28800;
const ON: GoalSettings = { dailyTargetSeconds: TARGET, goalNotification: true };

const dayOf = (ms: number): LocalDate => formatLocalDate(instantFromEpochMs(ms));

interface Harness {
    readonly service: GoalService;
    readonly writes: LocalDate[];
    readonly logs: string[];
    readonly reads: number;
    setWallClock(ms: number): void;
    /** Moves the wall clock to local midnight of the day after the one it is on. */
    toNextLocalDay(): void;
}

interface HarnessOptions {
    readonly store?: GoalNotificationStore;
    readonly wallOriginMs?: number;
}

function harness(options: HarnessOptions = {}): Harness {
    let wall = options.wallOriginMs ?? WALL_ORIGIN_MS;
    const clock: ClockPort = { now: () => wall, monotonicNow: () => 0 };

    const writes: LocalDate[] = [];
    const logs: string[] = [];
    const counters = { reads: 0 };

    let persisted: LocalDate | null = null;
    const inner: GoalNotificationStore = options.store ?? {
        read: () => persisted,
        write: (date) => { persisted = date; }
    };
    const store: GoalNotificationStore = {
        read: () => { counters.reads += 1; return inner.read(); },
        write: (date) => { writes.push(date); inner.write(date); }
    };

    return {
        service: createGoalService({ clock, store, log: (line) => logs.push(line) }),
        writes,
        logs,
        get reads() { return counters.reads; },
        setWallClock: (ms) => { wall = ms; },
        toNextLocalDay() {
            // Local midnight of the next day, from the one sanctioned date module - not wall + 86400000, which is
            // the wrong answer on a DST day and the whole reason SHARED-01 exists.
            wall = parseLocalDate(addDays(dayOf(wall), 1)).getTime() + 60_000;
        }
    };
}

describe('CORE-13: the decision, as a pure function', () => {
    const base = {
        date: '2026-09-12' as LocalDate,
        totalSecondsToday: TARGET,
        dailyTargetSeconds: TARGET,
        goalNotification: true,
        lastNotifiedDate: null
    };

    it('fires when the day total reaches the target', () => {
        expect(decideGoalNotification(base)).toEqual({ notify: true, date: base.date, reason: 'notify' });
    });

    it('fires on the target exactly, not only past it', () => {
        expect(decideGoalNotification({ ...base, totalSecondsToday: TARGET }).notify).toBe(true);
        expect(decideGoalNotification({ ...base, totalSecondsToday: TARGET - 1 }).reason).toBe('below-target');
    });

    it('stays silent when the user turned the notification off', () => {
        expect(decideGoalNotification({ ...base, goalNotification: false }).reason).toBe('disabled');
    });

    it('stays silent when today has already been notified', () => {
        expect(decideGoalNotification({ ...base, lastNotifiedDate: base.date }).reason)
            .toBe('already-notified-today');
    });

    it('fires again on the next day, which is the whole point of recording the day', () => {
        expect(decideGoalNotification({ ...base, lastNotifiedDate: addDays(base.date, -1) }).notify).toBe(true);
    });

    it('measures the day total, never one session (B7)', () => {
        // Four two-hour blocks are eight hours. v1.2.1 compared a single session against the target.
        const total = 4 * 7200;
        expect(decideGoalNotification({ ...base, totalSecondsToday: total }).notify).toBe(true);
    });

    it.each([
        ['zero', 0],
        ['negative', -1],
        ['not a number', Number.NaN]
    ])('refuses to fire against a %s target rather than firing instantly', (_label, dailyTargetSeconds) => {
        expect(decideGoalNotification({ ...base, dailyTargetSeconds }).reason).toBe('no-target');
    });

    it('treats a total that is not a number as below the target', () => {
        expect(decideGoalNotification({ ...base, totalSecondsToday: Number.NaN }).reason).toBe('below-target');
    });
});

describe('CORE-13: at most once per local day', () => {
    it('fires the first time the target is reached and not on the ticks after it', () => {
        const h = harness();
        expect(h.service.evaluate({ totalSecondsToday: TARGET, settings: ON }).notify).toBe(true);
        for (let i = 1; i <= 10; i += 1) {
            expect(h.service.evaluate({ totalSecondsToday: TARGET + i, settings: ON }).reason)
                .toBe('already-notified-today');
        }
        expect(h.writes, 'the day was recorded more than once').toEqual([dayOf(WALL_ORIGIN_MS)]);
    });

    it('fires again once the local day has rolled over', () => {
        const h = harness();
        expect(h.service.evaluate({ totalSecondsToday: TARGET, settings: ON }).notify).toBe(true);
        h.toNextLocalDay();
        const second = h.service.evaluate({ totalSecondsToday: TARGET, settings: ON });
        expect(second.notify).toBe(true);
        expect(second.date, 'the second day was recorded as the first').not.toBe(h.writes[0]);
        expect(h.writes).toHaveLength(2);
    });

    it('records nothing while the target is unmet, so tomorrow is still open', () => {
        const h = harness();
        h.service.evaluate({ totalSecondsToday: 10, settings: ON });
        expect(h.writes).toEqual([]);
    });

    it('records nothing when the notification is switched off, so switching it on still works today', () => {
        const h = harness();
        expect(h.service.evaluate({
            totalSecondsToday: TARGET, settings: { ...ON, goalNotification: false }
        }).reason).toBe('disabled');
        expect(h.writes).toEqual([]);
        expect(h.service.evaluate({ totalSecondsToday: TARGET, settings: ON }).notify).toBe(true);
    });

    it('consults the store once rather than on every tick', () => {
        const h = harness();
        for (let i = 0; i < 50; i += 1) h.service.evaluate({ totalSecondsToday: 10, settings: ON });
        expect(h.reads).toBe(1);
    });

    it('stays silent for the rest of the run even if the day could not be saved', () => {
        // A full disk must not turn the notification into one per second.
        const h = harness({
            store: { read: () => null, write: () => { throw new Error('disk is full'); } }
        });
        expect(h.service.evaluate({ totalSecondsToday: TARGET, settings: ON }).notify).toBe(true);
        expect(h.service.evaluate({ totalSecondsToday: TARGET, settings: ON }).reason)
            .toBe('already-notified-today');
        expect(h.logs.join(' ')).toContain('disk is full');
    });

    it('notifies rather than staying silent when the day cannot be read at all', () => {
        const h = harness({
            store: { read: () => { throw new Error('database is locked'); }, write: () => undefined }
        });
        expect(h.service.evaluate({ totalSecondsToday: TARGET, settings: ON }).notify).toBe(true);
        expect(h.logs.join(' ')).toContain('database is locked');
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-goal-' + tag + '-'));
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

describe('CORE-13: the day outlives the process', () => {
    /** Exactly what the container wires: app-state in, app-state out, no repository and no SQL. */
    function serviceOver(db: Database.Database, wallMs: number): Harness {
        return harness({
            wallOriginMs: wallMs,
            store: {
                read: () => readGoalNotifiedDate(db),
                write: (date) => { writeGoalNotifiedDate(db, date, instantFromEpochMs(wallMs)); }
            }
        });
    }

    it('does not fire again on a restart later the same day (B1)', async () => {
        const db = await migratedDatabase('restart-same-day');

        const morning = serviceOver(db, WALL_ORIGIN_MS);
        expect(morning.service.evaluate({ totalSecondsToday: TARGET, settings: ON }).notify).toBe(true);

        // A new process, five hours later: nothing carried over but the database.
        const evening = serviceOver(db, WALL_ORIGIN_MS + 5 * 3_600_000);
        expect(evening.service.evaluate({ totalSecondsToday: TARGET + 9000, settings: ON }))
            .toMatchObject({ notify: false, reason: 'already-notified-today' });
    });

    it('does fire on a restart the next local day', async () => {
        const db = await migratedDatabase('restart-next-day');

        const today = serviceOver(db, WALL_ORIGIN_MS);
        today.service.evaluate({ totalSecondsToday: TARGET, settings: ON });

        const tomorrowMs = parseLocalDate(addDays(dayOf(WALL_ORIGIN_MS), 1)).getTime() + 9 * 3_600_000;
        const tomorrow = serviceOver(db, tomorrowMs);
        const decision = tomorrow.service.evaluate({ totalSecondsToday: TARGET, settings: ON });
        expect(decision.notify).toBe(true);
        expect(decision.date).toBe(dayOf(tomorrowMs));
        expect(readGoalNotifiedDate(db)).toBe(dayOf(tomorrowMs));
    });

    it('honours the day v1.2.1 recorded, so the upgrade itself does not notify twice', async () => {
        const db = await migratedDatabase('upgrade');
        const today = dayOf(WALL_ORIGIN_MS);
        // Phase 4 imported this from localStorage; v1.2.1 wrote the same local YYYY-MM-DD (timer.js:246).
        importLegacyState(db, { timerState: null, lastGoalNotificationDate: today }, instantFromEpochMs(WALL_ORIGIN_MS));

        const after = serviceOver(db, WALL_ORIGIN_MS);
        expect(after.service.evaluate({ totalSecondsToday: TARGET, settings: ON }).reason)
            .toBe('already-notified-today');
    });
});

describe('CORE-02: the decision names no clock and no Electron of its own', () => {
    const source = read(SERVICE_FILE);

    it.each([
        ['Date.now(', 'the wall clock a system-clock change moves'],
        ['new Date(', 'a wall-clock instant'],
        ['setTimeout(', 'a repeat the scheduler port owns'],
        ['new Notification(', 'what v1.2.1 raised from the renderer; the notifier adapter raises it now'],
        ['NotifierPort', 'the port that acts on this decision, which this module must not reach for'],
        ['SoundPort', 'the other half of what Phase 8 does with a yes']
    ])('never names %s (%s)', (needle) => {
        expect(source.includes(needle), SERVICE_FILE + ' names ' + needle).toBe(false);
    });

    it('takes the day from the clock port and the record from a store', () => {
        expect(source).toContain("from '../ports'");
        expect(source).not.toContain("from '../lib/db");
        expect(source).not.toContain("from 'electron'");
    });
});

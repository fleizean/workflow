// D-18/D-34: a v1.2.1 timerState reaches app_state validated and idempotently on a migrated database, with no
// invented time and no work session created. Every subject is a mkdtemp database; no real krono.db is opened.

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { instantFromEpochMs } from '@shared/utils/date';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import { APP_STATE_KEYS, importLegacyState, readAppState, writeAppState } from '../src/lib/db/app-state';

const NOW = instantFromEpochMs(Date.UTC(2026, 8, 12, 9, 0, 0));
const NOW_ISO = '2026-09-12T09:00:00.000Z';
// A week before NOW: the gap v1.2.1's own restore would have added (B12).
const SAVED_AT = Date.UTC(2026, 8, 5, 9, 0, 0);
const LATER = Date.UTC(2026, 8, 6, 9, 0, 0);
const GOAL_DATE = '2026-09-12';

const savedState = (fields: Record<string, unknown>): string => JSON.stringify(fields);

const RUNNING_RAW = savedState({
    elapsed: 3600, running: true, pomodoroMode: false,
    pomodoroState: null, pomodoroSessionCount: 0, lastUpdated: SAVED_AT
});

const tempDirs: string[] = [];
const openDatabases: Database.Database[] = [];

afterAll(() => {
    for (const db of openDatabases) {
        closeDatabase(db);
    }
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh krono.db carried to LATEST through the real registry and the real baseline. */
async function migratedDatabase(tag: string): Promise<Database.Database> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-appstate-' + tag + '-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'krono.db');

    const probe = probeDatabase(dbPath);
    if (!probe.ok) {
        throw new Error('probe failed: ' + probe.reason);
    }
    const db = openDatabase(dbPath);
    openDatabases.push(db);
    const report = await migrateDatabase(db, {
        dbPath,
        dbClass: classify(probe.observed, LATEST),
        fromVersion: probe.observed.userVersion,
        backupDir: path.join(dir, 'backups')
    });
    if (report.toVersion !== LATEST) {
        throw new Error('migration stopped at user_version ' + String(report.toVersion));
    }
    return db;
}

const appStateRowCount = (db: Database.Database): number =>
    db.prepare<[], { c: number }>('SELECT count(*) AS c FROM app_state').get()?.c ?? 0;

interface SessionTotals {
    count: number;
    duration: number;
}

const sessionTotals = (db: Database.Database): SessionTotals => {
    const row = db.prepare<[], { c: number; d: number | null }>(
        'SELECT count(*) AS c, sum(duration) AS d FROM work_sessions'
    ).get();
    return { count: row?.c ?? 0, duration: row?.d ?? 0 };
};

// A synthetic session, so the "no session created" assertion compares against a non-zero baseline.
function seedSession(db: Database.Database): void {
    db.prepare<[string, number, string]>(
        'INSERT INTO work_sessions (name, duration, date, company_id) VALUES (?, ?, ?, 1)'
    ).run('Northwind Fixture session', 1800, '2026-09-11');
}

describe('tracer: a v1.2.1 timerState string reaches app_state and reads back parsed', () => {
    it('imports both keys, validated, and returns them through readAppState', async () => {
        const db = await migratedDatabase('tracer');

        const result = importLegacyState(db, { timerState: RUNNING_RAW, lastGoalNotificationDate: GOAL_DATE }, NOW);

        expect(result).toEqual({ timerState: 'imported', goalDate: 'imported' });
        expect(readAppState(db, APP_STATE_KEYS.legacyTimerState)).toEqual({
            raw: RUNNING_RAW,
            elapsedSeconds: 3600,
            wasRunning: true,
            pomodoroMode: false,
            pomodoroState: null,
            pomodoroSessionCount: 0,
            lastUpdated: SAVED_AT,
            importedAt: NOW_ISO
        });
        expect(readAppState(db, APP_STATE_KEYS.legacyGoalDate), 'the goal date is stored verbatim')
            .toEqual({ raw: GOAL_DATE, importedAt: NOW_ISO });
    });

    it('imports a week-old running record with exactly the saved elapsed (B12)', async () => {
        const db = await migratedDatabase('b12');

        importLegacyState(db, { timerState: RUNNING_RAW, lastGoalNotificationDate: null }, NOW);

        const stored = readAppState(db, APP_STATE_KEYS.legacyTimerState);
        expect(stored?.wasRunning, 'the stored record must be a running one, or B12 is not exercised').toBe(true);
        expect(NOW.getTime() - SAVED_AT, 'the gap must be a full week').toBe(7 * 24 * 60 * 60 * 1000);
        expect(stored?.elapsedSeconds, 'closed-app time was added to the imported timer').toBe(3600);
    });
});

describe('D-34: the import is idempotent and re-imports only on a changed lastUpdated', () => {
    it('reports unchanged for a second import of the same raw string', async () => {
        const db = await migratedDatabase('idempotent');

        const first = importLegacyState(db, { timerState: RUNNING_RAW, lastGoalNotificationDate: GOAL_DATE }, NOW);
        const before = readAppState(db, APP_STATE_KEYS.legacyTimerState);
        const second = importLegacyState(db, { timerState: RUNNING_RAW, lastGoalNotificationDate: GOAL_DATE }, NOW);

        expect(first).toEqual({ timerState: 'imported', goalDate: 'imported' });
        expect(second).toEqual({ timerState: 'unchanged', goalDate: 'unchanged' });
        expect(readAppState(db, APP_STATE_KEYS.legacyTimerState)).toEqual(before);
        expect(appStateRowCount(db), 'a re-import added a row').toBe(2);
    });

    it('re-imports when lastUpdated moved, and keeps the newer value', async () => {
        const db = await migratedDatabase('changed');
        const moved = savedState({
            elapsed: 7200, running: true, pomodoroMode: false,
            pomodoroState: null, pomodoroSessionCount: 0, lastUpdated: LATER
        });

        importLegacyState(db, { timerState: RUNNING_RAW, lastGoalNotificationDate: null }, NOW);
        const result = importLegacyState(db, { timerState: moved, lastGoalNotificationDate: null }, NOW);

        expect(result.timerState).toBe('imported');
        const stored = readAppState(db, APP_STATE_KEYS.legacyTimerState);
        expect(stored?.lastUpdated).toBe(LATER);
        expect(stored?.elapsedSeconds).toBe(7200);
        expect(stored?.raw).toBe(moved);
    });

    it('falls back to the raw string when the record carries no lastUpdated', async () => {
        const db = await migratedDatabase('noLastUpdated');
        const first = savedState({ elapsed: 10, running: false });
        const second = savedState({ elapsed: 20, running: false });

        expect(importLegacyState(db, { timerState: first, lastGoalNotificationDate: null }, NOW).timerState)
            .toBe('imported');
        expect(importLegacyState(db, { timerState: first, lastGoalNotificationDate: null }, NOW).timerState)
            .toBe('unchanged');
        expect(importLegacyState(db, { timerState: second, lastGoalNotificationDate: null }, NOW).timerState)
            .toBe('imported');
    });

    it('writes nothing for a key localStorage does not hold', async () => {
        const db = await migratedDatabase('absent');

        const result = importLegacyState(db, { timerState: null, lastGoalNotificationDate: null }, NOW);

        expect(result).toEqual({ timerState: 'absent', goalDate: 'absent' });
        expect(appStateRowCount(db)).toBe(0);
        expect(readAppState(db, APP_STATE_KEYS.legacyTimerState)).toBeNull();
    });

    it('re-imports over a recorded value its schema rejects, rather than blocking for good', async () => {
        const db = await migratedDatabase('corrupt');
        db.prepare<[string, string, string]>(
            'INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)'
        ).run(APP_STATE_KEYS.legacyTimerState, 'not json', NOW_ISO);

        expect(() => readAppState(db, APP_STATE_KEYS.legacyTimerState)).toThrow(/does not hold JSON/);

        const result = importLegacyState(db, { timerState: RUNNING_RAW, lastGoalNotificationDate: null }, NOW);

        expect(result.timerState).toBe('imported');
        expect(readAppState(db, APP_STATE_KEYS.legacyTimerState)?.elapsedSeconds).toBe(3600);
    });
});

describe('D-34: the import never creates a work session', () => {
    it('leaves the work_sessions count and summed duration untouched', async () => {
        const db = await migratedDatabase('sessions');
        seedSession(db);
        const before = sessionTotals(db);
        expect(before, 'the baseline must be non-zero, or this proves nothing').toEqual({ count: 1, duration: 1800 });

        importLegacyState(db, { timerState: RUNNING_RAW, lastGoalNotificationDate: GOAL_DATE }, NOW);
        importLegacyState(db, { timerState: RUNNING_RAW, lastGoalNotificationDate: GOAL_DATE }, NOW);
        importLegacyState(db, {
            timerState: savedState({ elapsed: 99, running: true, lastUpdated: LATER }),
            lastGoalNotificationDate: '2026-09-13'
        }, NOW);

        expect(sessionTotals(db), 'the import invented a session or changed tracked time').toEqual(before);
    });
});

describe('D-18: every app_state value is validated by its own key schema', () => {
    it('refuses a value the key schema rejects, and writes nothing', async () => {
        const db = await migratedDatabase('reject');

        expect(() => writeAppState(db, APP_STATE_KEYS.legacyTimerState, {
            raw: RUNNING_RAW,
            elapsedSeconds: -1,
            wasRunning: true,
            pomodoroMode: false,
            pomodoroState: null,
            pomodoroSessionCount: 0,
            lastUpdated: SAVED_AT,
            importedAt: NOW_ISO
        }, NOW), 'a negative elapsedSeconds passed its schema').toThrow();

        expect(appStateRowCount(db), 'the rejected value was written anyway').toBe(0);
    });

    it('round-trips a valid value through the upsert', async () => {
        const db = await migratedDatabase('upsert');

        writeAppState(db, APP_STATE_KEYS.legacyGoalDate, { raw: GOAL_DATE, importedAt: NOW_ISO }, NOW);
        writeAppState(db, APP_STATE_KEYS.legacyGoalDate, { raw: '2026-09-13', importedAt: NOW_ISO }, NOW);

        expect(appStateRowCount(db), 'the upsert inserted a second row for one key').toBe(1);
        expect(readAppState(db, APP_STATE_KEYS.legacyGoalDate)?.raw).toBe('2026-09-13');
    });

    it('refuses an unknown app_state key at compile time', () => {
        // Never called: the compiler is the assertion. TS2578 fails the build if the key ever becomes valid.
        const neverCalled = (db: Database.Database): void => {
            // @ts-expect-error 'legacy.v121.unknown' is not a declared app_state key
            readAppState(db, 'legacy.v121.unknown');
            // @ts-expect-error the goal-date schema does not accept a timer record
            writeAppState(db, APP_STATE_KEYS.legacyGoalDate, { raw: GOAL_DATE, elapsedSeconds: 1 }, NOW);
        };
        expect(typeof neverCalled).toBe('function');
    });
});

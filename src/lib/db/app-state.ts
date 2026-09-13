// app_state access, each value validated by its key's own zod schema (D-18), plus the idempotent v1.2.1 import (D-34).
// The import writes app_state alone: it never creates a work session and never invents elapsed time.

import { z } from 'zod';
import { LocalDateSchema, PomodoroIntervalSchema, TimerModeSchema } from '@shared/schemas';
import type DatabaseType from 'better-sqlite3';
import type { LocalDate, PomodoroInterval, TimerMode } from '@shared/types';
import { isLocalDate, utcIsoTimestamp } from '@shared/utils/date';
import { parseLegacyTimerState } from './legacy-timer';

export const APP_STATE_KEYS = Object.freeze({
    legacyTimerState: 'legacy.v121.timerState',
    legacyGoalDate: 'legacy.v121.lastGoalNotificationDate',
    timerState: 'timer.state',
    pomodoroState: 'pomodoro.state',
    goalNotifiedDate: 'goal.lastNotifiedDate',
    windowBounds: 'window.bounds',
    hideNoticeShown: 'window.hideNoticeShown'
} as const);

export const LegacyTimerRecordSchema = z.strictObject({
    raw: z.string(),
    elapsedSeconds: z.int().nonnegative().nullable(),
    wasRunning: z.boolean().nullable(),
    pomodoroMode: z.boolean().nullable(),
    pomodoroState: z.string().nullable(),
    pomodoroSessionCount: z.int().nonnegative().nullable(),
    lastUpdated: z.int().nonnegative().nullable(),
    importedAt: z.string()
});

export const LegacyGoalDateSchema = z.strictObject({
    raw: z.string(),
    importedAt: z.string()
});

// CORE-07: a scalar count of seconds and nothing else. The absence of a startTime field is the point - it is what
// makes B12 and B13 unexpressible rather than merely unwritten.
export const TimerStateRecordSchema = z.strictObject({
    accumulatedSeconds: z.int().nonnegative(),
    mode: TimerModeSchema,
    updatedAt: z.string()
});

/*
 * WR-03: the seconds a pomodoro interval had counted when the process last stopped. Like the timer's record this is
 * a scalar count and no start timestamp, so the gap between two launches cannot be credited. The day is deliberately
 * absent: a pomodoro belongs to the day it finishes on, which is the rule an interval running across midnight
 * already follows, and storing a day that is never read would invite the question why.
 */
export const PomodoroStateRecordSchema = z.strictObject({
    interval: PomodoroIntervalSchema,
    elapsedSeconds: z.int().nonnegative(),
    updatedAt: z.string()
});

// CORE-13: the local day the goal notification last fired on. v1.2.1 kept this in localStorage, which main cannot
// read and a profile reset clears, and its in-memory sibling flag re-armed on every reload (index.html:945, B1).
export const GoalNotifiedRecordSchema = z.strictObject({
    date: LocalDateSchema,
    notifiedAt: z.string()
});

// IPC-05: where the window was, in the database rather than in a JSON file beside it - one thing to back up, one
// thing to migrate, and no second store that can disagree with the first. x and y are signed: a display to the left
// of the primary one has negative coordinates, and refusing them would be refusing a legitimate position.
export const WindowBoundsRecordSchema = z.strictObject({
    x: z.int(),
    y: z.int(),
    width: z.int().positive(),
    height: z.int().positive(),
    updatedAt: z.string()
});

/*
 * Owner decision 2026-09-13: the hide button says once where the window went, and never again. The row is the flag -
 * its presence is the whole answer, and the timestamp is there so a reader can see when it was set. In app_state
 * rather than in localStorage, which the renderer may not touch (ARCH-03) and main could not read anyway.
 */
export const HideNoticeRecordSchema = z.strictObject({ shownAt: z.string() });

const SCHEMAS = {
    'legacy.v121.timerState': LegacyTimerRecordSchema,
    'legacy.v121.lastGoalNotificationDate': LegacyGoalDateSchema,
    'timer.state': TimerStateRecordSchema,
    'pomodoro.state': PomodoroStateRecordSchema,
    'goal.lastNotifiedDate': GoalNotifiedRecordSchema,
    'window.bounds': WindowBoundsRecordSchema,
    'window.hideNoticeShown': HideNoticeRecordSchema
} as const;

export type AppStateKey = keyof typeof SCHEMAS;
export type AppStateValue<K extends AppStateKey> = z.infer<(typeof SCHEMAS)[K]>;

type StoredTimerState = AppStateValue<typeof APP_STATE_KEYS.legacyTimerState>;
type StoredGoalDate = AppStateValue<typeof APP_STATE_KEYS.legacyGoalDate>;

// Table and column names are literals from this module; only the key and the value are ever bound (T-01-35).
const SELECT_VALUE = 'SELECT value FROM app_state WHERE key = ?';
const UPSERT_VALUE =
    'INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';

// Error text names the key and never the value: an app_state value is user state (T-01-37).
export function readAppState<K extends AppStateKey>(db: DatabaseType.Database, key: K): AppStateValue<K> | null {
    const row = db.prepare<[string], { value: string }>(SELECT_VALUE).get(key);
    if (row === undefined) {
        return null;
    }
    let stored: unknown;
    try {
        stored = JSON.parse(row.value);
    } catch {
        throw new Error('app_state key "' + key + '" does not hold JSON.');
    }
    const result = SCHEMAS[key].safeParse(stored);
    if (!result.success) {
        throw new Error('app_state key "' + key + '" holds a value its schema rejects.');
    }
    // safeParse over the key-indexed map widens to the union of both schemas; the value just passed the one
    // SCHEMAS maps this key to, so narrowing it back to that key's type is sound.
    return result.data as AppStateValue<K>;
}

export function writeAppState<K extends AppStateKey>(
    db: DatabaseType.Database,
    key: K,
    value: AppStateValue<K>,
    now: Date = new Date()
): void {
    const validated: unknown = SCHEMAS[key].parse(value);
    db.prepare<[string, string, string]>(UPSERT_VALUE).run(key, JSON.stringify(validated), utcIsoTimestamp(now));
}

export type LegacyImportOutcome = 'imported' | 'unchanged' | 'absent';

export interface LegacyImportResult {
    readonly timerState: LegacyImportOutcome;
    readonly goalDate: LegacyImportOutcome;
}

export interface LegacyStorageValues {
    readonly timerState: string | null;
    readonly lastGoalNotificationDate: string | null;
}

// A recorded value the schema rejects counts as none, so a corrupt row re-imports instead of blocking the import.
function recorded<K extends AppStateKey>(db: DatabaseType.Database, key: K): AppStateValue<K> | null {
    try {
        return readAppState(db, key);
    } catch {
        return null;
    }
}

/** Where a restored value came from, so a caller can tell a real carry-over from an empty database. */
export type TimerStateSource = 'persisted' | 'legacy' | 'none';

export interface RestoredTimerState {
    readonly accumulatedSeconds: number;
    readonly mode: TimerMode;
    readonly source: TimerStateSource;
}

/**
 * The seconds a previous launch had counted, and nothing derived from how long ago that launch was: this reads no
 * clock, so the gap between the two runs cannot be credited (CORE-05, B12). A v2 value wins; with none, the v1.2.1
 * state Phase 4 imported is the fallback; with neither, the timer starts at zero.
 */
export function readTimerState(db: DatabaseType.Database): RestoredTimerState {
    const persisted = recorded(db, APP_STATE_KEYS.timerState);
    if (persisted !== null) {
        return { accumulatedSeconds: persisted.accumulatedSeconds, mode: persisted.mode, source: 'persisted' };
    }
    const legacy = recorded(db, APP_STATE_KEYS.legacyTimerState);
    if (legacy === null || legacy.elapsedSeconds === null || legacy.elapsedSeconds === 0) {
        return { accumulatedSeconds: 0, mode: 'work', source: 'none' };
    }
    // legacy.wasRunning is left unread on purpose: v1.2.1 resumed a running timer by subtracting a stored startTime
    // from the current wall clock, which is the whole of B12. Restoring paused is the owner's decision G3/G4.
    return {
        accumulatedSeconds: legacy.elapsedSeconds,
        mode: legacy.pomodoroMode === true ? 'pomodoro' : 'work',
        source: 'legacy'
    };
}

export interface TimerStateInput {
    readonly accumulatedSeconds: number;
    readonly mode: TimerMode;
}

/** Writes the v2 key only. The imported v1.2.1 record is a record of what was found and is never overwritten. */
export function writeTimerState(db: DatabaseType.Database, state: TimerStateInput, now: Date): void {
    writeAppState(db, APP_STATE_KEYS.timerState, { ...state, updatedAt: utcIsoTimestamp(now) }, now);
}

/**
 * The local day the daily-goal notification last fired on, or null if it never has. Like readTimerState it reads no
 * clock - the caller's clock names today, this only says which day is already spoken for. The v1.2.1 value is the
 * fallback, so upgrading at noon does not re-raise a notification the user saw that morning: it held the same local
 * YYYY-MM-DD getCurrentDate() produced (legacy/renderer/timer.js:246), and anything else counts as none.
 */
export function readGoalNotifiedDate(db: DatabaseType.Database): LocalDate | null {
    const persisted = recorded(db, APP_STATE_KEYS.goalNotifiedDate);
    if (persisted !== null) {
        return persisted.date;
    }
    const legacy = recorded(db, APP_STATE_KEYS.legacyGoalDate);
    return legacy !== null && isLocalDate(legacy.raw) ? legacy.raw : null;
}

export function writeGoalNotifiedDate(db: DatabaseType.Database, date: LocalDate, now: Date): void {
    writeAppState(db, APP_STATE_KEYS.goalNotifiedDate, { date, notifiedAt: utcIsoTimestamp(now) }, now);
}

export interface RestoredPomodoroState {
    readonly interval: PomodoroInterval;
    readonly elapsedSeconds: number;
}

/**
 * What a previous launch had counted toward the interval it was on, or null - including when the stored value no
 * longer parses. Reads no clock, so nothing about how long ago that launch was can be credited (WR-03, CORE-05).
 */
export function readPomodoroState(db: DatabaseType.Database): RestoredPomodoroState | null {
    const stored = recorded(db, APP_STATE_KEYS.pomodoroState);
    return stored === null ? null : { interval: stored.interval, elapsedSeconds: stored.elapsedSeconds };
}

export function writePomodoroState(db: DatabaseType.Database, state: RestoredPomodoroState, now: Date): void {
    writeAppState(db, APP_STATE_KEYS.pomodoroState, { ...state, updatedAt: utcIsoTimestamp(now) }, now);
}

export interface StoredWindowBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** Where the window was when it was last put away, or null - including when the stored value no longer parses. */
export function readWindowBounds(db: DatabaseType.Database): StoredWindowBounds | null {
    const stored = recorded(db, APP_STATE_KEYS.windowBounds);
    return stored === null ? null : { x: stored.x, y: stored.y, width: stored.width, height: stored.height };
}

export function writeWindowBounds(db: DatabaseType.Database, bounds: StoredWindowBounds, now: Date): void {
    writeAppState(db, APP_STATE_KEYS.windowBounds, { ...bounds, updatedAt: utcIsoTimestamp(now) }, now);
}

/** Whether the user has already been told where the hide button puts the window; a corrupt row counts as not yet. */
export function readHideNoticeShown(db: DatabaseType.Database): boolean {
    return recorded(db, APP_STATE_KEYS.hideNoticeShown) !== null;
}

export function markHideNoticeShown(db: DatabaseType.Database, now: Date): void {
    writeAppState(db, APP_STATE_KEYS.hideNoticeShown, { shownAt: utcIsoTimestamp(now) }, now);
}

// The raw string decides whenever either side carries no lastUpdated to compare (D-34).
function timerStateDiffers(previous: StoredTimerState | null, incoming: StoredTimerState): boolean {
    if (previous === null) {
        return true;
    }
    if (previous.lastUpdated === null || incoming.lastUpdated === null) {
        return previous.raw !== incoming.raw;
    }
    return previous.lastUpdated !== incoming.lastUpdated;
}

/** One immediate transaction over app_state only. A key that is absent in localStorage writes nothing. */
export function importLegacyState(
    db: DatabaseType.Database,
    values: LegacyStorageValues,
    now: Date
): LegacyImportResult {
    return db.transaction((): LegacyImportResult => {
        let timerState: LegacyImportOutcome = 'absent';
        if (values.timerState !== null) {
            const incoming = parseLegacyTimerState(values.timerState, now);
            if (timerStateDiffers(recorded(db, APP_STATE_KEYS.legacyTimerState), incoming)) {
                writeAppState(db, APP_STATE_KEYS.legacyTimerState, incoming, now);
                timerState = 'imported';
            } else {
                timerState = 'unchanged';
            }
        }

        let goalDate: LegacyImportOutcome = 'absent';
        if (values.lastGoalNotificationDate !== null) {
            const previous: StoredGoalDate | null = recorded(db, APP_STATE_KEYS.legacyGoalDate);
            if (previous === null || previous.raw !== values.lastGoalNotificationDate) {
                const value = { raw: values.lastGoalNotificationDate, importedAt: utcIsoTimestamp(now) };
                writeAppState(db, APP_STATE_KEYS.legacyGoalDate, value, now);
                goalDate = 'imported';
            } else {
                goalDate = 'unchanged';
            }
        }

        return { timerState, goalDate };
    }).immediate();
}

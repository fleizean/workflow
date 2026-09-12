// app_state access, each value validated by its key's own zod schema (D-18), plus the idempotent v1.2.1 import (D-34).
// The import writes app_state alone: it never creates a work session and never invents elapsed time.

import { z } from 'zod';
import type DatabaseType from 'better-sqlite3';
import { utcIsoTimestamp } from '@shared/utils/date';
import { parseLegacyTimerState } from './legacy-timer';

export const APP_STATE_KEYS = Object.freeze({
    legacyTimerState: 'legacy.v121.timerState',
    legacyGoalDate: 'legacy.v121.lastGoalNotificationDate'
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

const SCHEMAS = {
    'legacy.v121.timerState': LegacyTimerRecordSchema,
    'legacy.v121.lastGoalNotificationDate': LegacyGoalDateSchema
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

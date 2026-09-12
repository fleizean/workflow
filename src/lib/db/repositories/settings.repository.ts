// settings. The one place the v1.2.1 key strings live; callers see the ten-key Settings object and nothing else.
// Rows outside DOMAIN_KEYS are read by nobody and written by nobody, so what v1.2.1 stored there stays there.

import { sql } from 'drizzle-orm';
import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import { settings } from '../schema';
import type { DbHandle } from '../handle';
import type { Settings } from '@shared/types';

type BooleanKey = {
    [K in keyof Settings]: Settings[K] extends boolean ? K : never
}[keyof Settings];

// v1.2.1's key strings, in database/db.js seed order.
const DOMAIN_KEYS: Readonly<Record<keyof Settings, string>> = {
    dailyTargetSeconds: 'daily_target',
    goalNotification: 'goal_notification',
    excludeWeekendsFromStreak: 'exclude_weekends_from_streak',
    pomodoroEnabled: 'pomodoro_enabled',
    pomodoroWorkSeconds: 'pomodoro_work_duration',
    pomodoroShortBreakSeconds: 'pomodoro_short_break',
    pomodoroLongBreakSeconds: 'pomodoro_long_break',
    pomodoroSessionsUntilLongBreak: 'pomodoro_sessions_until_long_break',
    pomodoroAutoStartBreaks: 'pomodoro_auto_start_breaks',
    pomodoroAutoStartWork: 'pomodoro_auto_start_work'
};

const BOOLEAN_KEYS: readonly BooleanKey[] = [
    'goalNotification', 'excludeWeekendsFromStreak', 'pomodoroEnabled', 'pomodoroAutoStartBreaks',
    'pomodoroAutoStartWork'
];

const isBooleanKey = (key: keyof Settings): key is BooleanKey => (BOOLEAN_KEYS as readonly string[]).includes(key);

export interface SettingsRepository {
    /** Every key, always. A row that is missing or holds something the domain cannot use reads as its v1.2.1 seed. */
    get(): Settings;
    /** Writes only the keys present in the patch, then returns the whole object. */
    update(patch: Partial<Settings>): Settings;
}

function parseBoolean(stored: string | undefined, fallback: boolean): boolean {
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return fallback;
}

function parsePositiveInt(stored: string | undefined, fallback: number): number {
    if (stored === undefined) return fallback;
    const value = Number(stored);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createSettingsRepository(handle: DbHandle): SettingsRepository {
    function readAll(): Settings {
        const stored = new Map<string, string>();
        for (const row of handle.select({ key: settings.key, value: settings.value }).from(settings).all()) {
            // SQLite reports notnull 0 for a legacy PRIMARY KEY column, so settings.key really can be NULL even
            // though the declared type says otherwise (Phase 4, 04-08). Such a row addresses nothing; skip it.
            if (typeof row.key !== 'string' || typeof row.value !== 'string') continue;
            stored.set(row.key, row.value);
        }

        const read = <K extends keyof Settings>(key: K): Settings[K] => {
            const raw = stored.get(DOMAIN_KEYS[key]);
            const fallback = DEFAULT_SETTINGS[key];
            const value = isBooleanKey(key)
                ? parseBoolean(raw, fallback as boolean)
                : parsePositiveInt(raw, fallback as number);
            return value as Settings[K];
        };

        const keys = Object.keys(DOMAIN_KEYS) as (keyof Settings)[];
        const result: Partial<Record<keyof Settings, Settings[keyof Settings]>> = {};
        for (const key of keys) result[key] = read(key);
        return result as Settings;
    }

    return {
        get: readAll,

        update(patch) {
            const entries = (Object.keys(DOMAIN_KEYS) as (keyof Settings)[])
                .filter((key) => patch[key] !== undefined)
                .map((key) => ({ key: DOMAIN_KEYS[key], value: String(patch[key]) }));

            handle.$client.transaction(() => {
                for (const entry of entries) {
                    handle.insert(settings).values(entry)
                        .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value` } })
                        .run();
                }
            }).immediate();

            return readAll();
        }
    };
}

/** Exported for the guard that proves the mapping still covers every domain key; not part of the repository API. */
export const SETTINGS_KEY_MAP: Readonly<Record<keyof Settings, string>> = DOMAIN_KEYS;

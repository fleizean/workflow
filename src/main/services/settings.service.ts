// CORE-03: the settings boundary Phase 8's screens write through. It validates, then calls slice B's repository
// once; the ten-key Settings shape and the v1.2.1 key strings stay where they already live.

import type { Settings } from '@shared/types';

/** Structural, so nothing here imports src/lib/db: the container passes the settings repository itself. */
export interface SettingsStore {
    get(): Settings;
    update(patch: Partial<Settings>): Settings;
}

type NumericKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BooleanKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

export interface SettingBound {
    readonly min: number;
    readonly max: number;
    /** What the number means, for the message the user is shown when it is refused. */
    readonly unit: 'seconds' | 'pomodoros';
}

/*
 * Why these bounds and not others.
 *
 * A minute is the floor for every duration because v1.2.1's settings UI is a number of minutes, so anything shorter
 * is untypable there - and a pomodoro of a few seconds is a completion loop that would write a row a second.
 *
 * The daily target is capped at a full day: a target above 86400 can never be met, so the streak could never advance
 * and the goal notification could never fire - a value that silently disables two features is worse than a refusal.
 *
 * Four hours caps the pomodoro intervals. A work interval is bounded by attention, not by the clock, and the point
 * of the cap is the same as the floor's: to refuse a value no one meant to type, not to have an opinion about
 * anyone's technique.
 *
 * The long-break cycle must be at least 1 - the derivation in pomodoro.service.ts takes completedToday modulo this
 * number, and a stored 0 would make the next break NaN rather than wrong. Twelve is the ceiling because a cycle
 * longer than that cannot complete inside a working day, so the long break would never arrive.
 */
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 14400;
export const MAX_DAILY_TARGET_SECONDS = 86400;
export const MAX_SESSIONS_UNTIL_LONG_BREAK = 12;

const interval = (): SettingBound => ({ min: MIN_INTERVAL_SECONDS, max: MAX_INTERVAL_SECONDS, unit: 'seconds' });

export const SETTINGS_BOUNDS: Readonly<Record<NumericKey, SettingBound>> = Object.freeze({
    dailyTargetSeconds: { min: MIN_INTERVAL_SECONDS, max: MAX_DAILY_TARGET_SECONDS, unit: 'seconds' },
    pomodoroWorkSeconds: interval(),
    pomodoroShortBreakSeconds: interval(),
    pomodoroLongBreakSeconds: interval(),
    pomodoroSessionsUntilLongBreak: { min: 1, max: MAX_SESSIONS_UNTIL_LONG_BREAK, unit: 'pomodoros' }
});

export const BOOLEAN_SETTING_KEYS: readonly BooleanKey[] = Object.freeze([
    'goalNotification', 'excludeWeekendsFromStreak', 'pomodoroEnabled', 'pomodoroAutoStartBreaks',
    'pomodoroAutoStartWork'
]);

const NUMERIC_SETTING_KEYS = Object.keys(SETTINGS_BOUNDS) as NumericKey[];

/** Every key the domain has, so an unknown one is refused rather than written to a row nobody reads. */
export const SETTING_KEYS: readonly (keyof Settings)[] =
    Object.freeze([...NUMERIC_SETTING_KEYS, ...BOOLEAN_SETTING_KEYS]);

/** A refused write, named by the key that caused it. Durations and targets are not user data, so the value is said. */
export class SettingsValidationError extends Error {
    readonly key: string;

    constructor(key: string, message: string) {
        super(message);
        this.name = 'SettingsValidationError';
        this.key = key;
    }
}

const describe = (value: unknown): string =>
    typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value) ?? typeof value;

/**
 * The keys of `patch` that are actually set, each checked against its bound. Throws on the first refusal rather
 * than writing part of a patch: a settings form that half-applied would be harder to reason about than one refused.
 */
export function validateSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
    const known = new Set<string>(SETTING_KEYS);
    for (const key of Object.keys(patch)) {
        if (!known.has(key)) {
            throw new SettingsValidationError(key, 'settings: "' + key + '" is not a setting this app has.');
        }
    }

    const checked: Partial<Record<keyof Settings, number | boolean>> = {};

    for (const key of BOOLEAN_SETTING_KEYS) {
        const value: unknown = patch[key];
        if (value === undefined) continue;
        if (typeof value !== 'boolean') {
            throw new SettingsValidationError(key, 'settings: ' + key + ' is on or off, got ' + describe(value) + '.');
        }
        checked[key] = value;
    }

    for (const key of NUMERIC_SETTING_KEYS) {
        const value: unknown = patch[key];
        if (value === undefined) continue;
        const bound = SETTINGS_BOUNDS[key];
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
            throw new SettingsValidationError(
                key, 'settings: ' + key + ' is a whole number of ' + bound.unit + ', got ' + describe(value) + '.');
        }
        if (value < bound.min || value > bound.max) {
            throw new SettingsValidationError(
                key, 'settings: ' + key + ' must be between ' + String(bound.min) + ' and ' + String(bound.max) +
                ' ' + bound.unit + ', got ' + String(value) + '.');
        }
        checked[key] = value;
    }

    return checked as Partial<Settings>;
}

export interface SettingsService {
    /** What is stored, as the repository reads it. Validation guards the write, not the read (see the summary). */
    get(): Settings;
    /** Validates the whole patch, then writes the keys it actually sets. A refused patch writes nothing. */
    update(patch: Partial<Settings>): Settings;
}

export function createSettingsService(store: SettingsStore): SettingsService {
    return {
        get: () => store.get(),

        update(patch) {
            const checked = validateSettingsPatch(patch);
            // Nothing to write is not an error - a form that submits unchanged still wants the current settings back.
            return Object.keys(checked).length === 0 ? store.get() : store.update(checked);
        }
    };
}

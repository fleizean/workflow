// v1.2.1's settings seeds as typed defaults; zod-free, so the renderer and fresh-install seeding can import it.
import type { Settings } from '@shared/types';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
    dailyTargetSeconds: 28800,
    goalNotification: true,
    excludeWeekendsFromStreak: false,
    pomodoroEnabled: false,
    pomodoroWorkSeconds: 1500,
    pomodoroShortBreakSeconds: 300,
    pomodoroLongBreakSeconds: 900,
    pomodoroSessionsUntilLongBreak: 4,
    pomodoroAutoStartBreaks: true,
    pomodoroAutoStartWork: false
});

export type NumericSettingKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
export type BooleanSettingKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

export interface SettingBound {
    readonly min: number;
    readonly max: number;
    /** What the number means, for the message the user is shown when it is refused. */
    readonly unit: 'seconds' | 'pomodoros';
}

/*
 * The bounds src/main/services/settings.service.ts refuses on, declared here because the Settings screen has to
 * SHOW them: the service refuses rather than clamps, so a value outside a bound has to be explainable before it is
 * sent. A screen carrying its own copy would either promise a value main refuses or refuse one main accepts, the
 * first time a bound moved. Why each bound is what it is stays with the enforcement, in the service.
 */
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 14400;
export const MAX_DAILY_TARGET_SECONDS = 86400;
export const MAX_SESSIONS_UNTIL_LONG_BREAK = 12;

const interval = (): SettingBound => ({ min: MIN_INTERVAL_SECONDS, max: MAX_INTERVAL_SECONDS, unit: 'seconds' });

export const SETTINGS_BOUNDS: Readonly<Record<NumericSettingKey, SettingBound>> = Object.freeze({
    dailyTargetSeconds: { min: MIN_INTERVAL_SECONDS, max: MAX_DAILY_TARGET_SECONDS, unit: 'seconds' },
    pomodoroWorkSeconds: interval(),
    pomodoroShortBreakSeconds: interval(),
    pomodoroLongBreakSeconds: interval(),
    pomodoroSessionsUntilLongBreak: { min: 1, max: MAX_SESSIONS_UNTIL_LONG_BREAK, unit: 'pomodoros' }
});

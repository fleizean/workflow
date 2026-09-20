// v1.2.1's settings seeds as typed defaults; zod-free, so the renderer and fresh-install seeding can import it.
import type { Settings } from '@shared/types';

/*
 * The notification sounds the app ships, and the only ones a user can pick between. Bundled files, never a path or
 * a URL the user supplies: the Settings screen offers this list and main refuses anything outside it. Each one is
 * under a second long, and level-matched to each other (src/assets/sounds/, see LICENSE.txt there). 'classic' is the default: a soft, short confirmation tone chosen to be easy to live with all day.
 */
export const SOUND_CHOICES = Object.freeze([
    { id: 'classic', label: 'Classic' },
    { id: 'chime', label: 'Chime' },
    { id: 'glass', label: 'Glass' },
    { id: 'confirm', label: 'Confirm' },
    { id: 'question', label: 'Question' },
    { id: 'two-tone', label: 'Two Tone' },
    { id: 'three-tone', label: 'Three Tone' },
    { id: 'rise', label: 'Rise' },
    { id: 'pep', label: 'Pep' }
] as const);

export const SOUND_CHOICE_IDS = SOUND_CHOICES.map((choice) => choice.id) as unknown as readonly [
    (typeof SOUND_CHOICES)[number]['id'], ...(typeof SOUND_CHOICES)[number]['id'][]
];

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
    dailyTargetSeconds: 28800,
    goalNotification: true,
    soundEnabled: true,
    notificationSound: 'classic',
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
 * The bounds src/main/services/settings.service.ts refuses on, declared here because the Settings screen has to SHOW
 * them: the service refuses rather than clamps, so a value outside a bound has to be explainable before it is sent.
 * A screen carrying its own copy would promise a value main refuses the first time a bound moved.
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

/*
 * What the Settings screen decides, in one place a test can run. There is no jsdom here, so this is where SET-01..05
 * are provable.
 *
 * The decision the rest of the file follows from: the settings service REFUSES a value outside its bounds, it does
 * not clamp one (Phase 5). So the screen has to be able to say what is wrong with a number before it sends it, out
 * of @shared/constants/settings - the same declaration main enforces. It refuses the whole patch, as the service does.
 */

import { SETTINGS_BOUNDS } from '@shared/constants/settings';
import type { NumericSettingKey } from '@shared/constants/settings';
import type { Settings } from '@shared/types';

/** The identifier the danger-zone button is reached by. See the note on DANGER_NOTE below. */
export const DESTRUCTIVE_ACTION_ID = 'reset-all-data';

/** Everything the form may write. pomodoroEnabled is absent on purpose - api/useTimerMode.ts owns that one key. */
export type SettingsPatch = Partial<Omit<Settings, 'pomodoroEnabled'>>;

export type NumberFieldKey =
    'pomodoroWorkSeconds' | 'pomodoroShortBreakSeconds' | 'pomodoroLongBreakSeconds' |
    'pomodoroSessionsUntilLongBreak';

export interface NumberField {
    readonly key: NumberFieldKey;
    readonly label: string;
    readonly icon: string;
    /** v1.2.1's helper line under the input. */
    readonly hint: string;
    /** Seconds per typed unit: the three durations are typed in minutes, the cycle length in pomodoros. */
    readonly secondsPerUnit: number;
    readonly unit: 'minutes' | 'pomodoros';
}

const MINUTE = 60;

export const NUMBER_FIELDS: readonly NumberField[] = Object.freeze([
    {
        key: 'pomodoroWorkSeconds', label: 'Work Duration', icon: 'work',
        hint: 'Minutes per work session', secondsPerUnit: MINUTE, unit: 'minutes'
    },
    {
        key: 'pomodoroShortBreakSeconds', label: 'Short Break', icon: 'coffee',
        hint: 'Minutes for short breaks', secondsPerUnit: MINUTE, unit: 'minutes'
    },
    {
        key: 'pomodoroLongBreakSeconds', label: 'Long Break', icon: 'beach_access',
        hint: 'Minutes for long breaks', secondsPerUnit: MINUTE, unit: 'minutes'
    },
    {
        key: 'pomodoroSessionsUntilLongBreak', label: 'Pomodoros Until Long Break', icon: 'repeat',
        hint: 'Number of work sessions before long break', secondsPerUnit: 1, unit: 'pomodoros'
    }
] as const);

export interface UnitBound {
    readonly min: number;
    readonly max: number;
}

/** The service's bound for this field, in the unit the field is typed in. */
export function boundOf(field: NumberField): UnitBound {
    const bound = SETTINGS_BOUNDS[field.key];
    return { min: bound.min / field.secondsPerUnit, max: bound.max / field.secondsPerUnit };
}

export const DAILY_TARGET_LABEL = 'Daily Target';
const DAILY_TARGET_BOUND = SETTINGS_BOUNDS.dailyTargetSeconds;

const TWO_DIGITS = 2;
const PAD = '0';
const HOUR = 3600;

/** `08:00` - the daily target as v1.2.1 displayed and typed it. 86400 reads as `24:00`, which is its own cap. */
export function formatTargetClock(totalSeconds: number): string {
    const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
    const hours = Math.floor(safe / HOUR);
    const minutes = Math.floor((safe % HOUR) / MINUTE);
    return [hours, minutes].map((part) => String(part).padStart(TWO_DIGITS, PAD)).join(':');
}

export function targetSecondsOf(hours: number, minutes: number): number {
    const safe = (value: number): number => (Number.isFinite(value) ? Math.floor(value) : 0);
    return Math.max(0, safe(hours)) * HOUR + Math.max(0, safe(minutes)) * MINUTE;
}

/** The six one-tap targets legacy/pages/settings.html:591 offered. */
export const QUICK_TARGET_HOURS: readonly number[] = Object.freeze([6, 7, 8, 9, 10, 12]);

/** What the form holds. Numbers are the text that was typed: an empty box is not a zero. */
export interface SettingsDraft {
    readonly dailyTargetSeconds: number;
    readonly numbers: Readonly<Record<NumberFieldKey, string>>;
    readonly goalNotification: boolean;
    readonly excludeWeekendsFromStreak: boolean;
    readonly pomodoroAutoStartBreaks: boolean;
    readonly pomodoroAutoStartWork: boolean;
}

export function draftFrom(settings: Settings): SettingsDraft {
    const numbers = {} as Record<NumberFieldKey, string>;
    for (const field of NUMBER_FIELDS) {
        numbers[field.key] = String(Math.round(settings[field.key] / field.secondsPerUnit));
    }
    return {
        dailyTargetSeconds: settings.dailyTargetSeconds,
        numbers,
        goalNotification: settings.goalNotification,
        excludeWeekendsFromStreak: settings.excludeWeekendsFromStreak,
        pomodoroAutoStartBreaks: settings.pomodoroAutoStartBreaks,
        pomodoroAutoStartWork: settings.pomodoroAutoStartWork
    };
}

export interface DraftReview {
    /** One message per refused key, in the words the user can act on. Empty means nothing was refused. */
    readonly errors: Readonly<Partial<Record<NumericSettingKey, string>>>;
    /** The keys that actually changed, and only those: a value nobody touched is never rewritten. */
    readonly patch: SettingsPatch;
}

export const isRefused = (review: DraftReview): boolean => Object.keys(review.errors).length > 0;
export const hasChanges = (review: DraftReview): boolean => Object.keys(review.patch).length > 0;

const WHOLE_NUMBER = /^\d+$/;

/**
 * The draft against the stored settings: what is wrong with it, and what of it is new. A refused draft carries an
 * empty patch - the service refuses a whole patch rather than writing part of one, and a form that half-applied
 * would be harder to reason about than one refused.
 */
export function reviewDraft(draft: SettingsDraft, stored: Settings): DraftReview {
    const errors: Partial<Record<NumericSettingKey, string>> = {};
    const patch: Record<string, number | boolean> = {};
    /*
     * A field is compared as TEXT against what the stored value reads as, not as a number: 90 stored seconds show as
     * 2 minutes, and writing 120 back over a value nobody touched is the silent edit the service refuses to make.
     */
    const baseline = draftFrom(stored);

    for (const field of NUMBER_FIELDS) {
        const typed = draft.numbers[field.key].trim();
        if (typed === baseline.numbers[field.key]) {
            continue;
        }
        if (!WHOLE_NUMBER.test(typed)) {
            errors[field.key] = field.label + ' is a whole number of ' + field.unit + '.';
            continue;
        }
        const bound = boundOf(field);
        const value = Number(typed);
        if (value < bound.min || value > bound.max) {
            errors[field.key] = field.label + ' must be between ' + String(bound.min) + ' and ' +
                String(bound.max) + ' ' + field.unit + '.';
            continue;
        }
        const seconds = value * field.secondsPerUnit;
        if (seconds !== stored[field.key]) {
            patch[field.key] = seconds;
        }
    }

    const target = draft.dailyTargetSeconds;
    if (!Number.isSafeInteger(target) || target < DAILY_TARGET_BOUND.min || target > DAILY_TARGET_BOUND.max) {
        errors.dailyTargetSeconds = DAILY_TARGET_LABEL + ' must be between ' +
            formatTargetClock(DAILY_TARGET_BOUND.min) + ' and ' + formatTargetClock(DAILY_TARGET_BOUND.max) + '.';
    } else if (target !== stored.dailyTargetSeconds) {
        patch.dailyTargetSeconds = target;
    }

    for (const key of ['goalNotification', 'excludeWeekendsFromStreak', 'pomodoroAutoStartBreaks',
        'pomodoroAutoStartWork'] as const) {
        if (draft[key] !== stored[key]) {
            patch[key] = draft[key];
        }
    }

    const refused = Object.keys(errors).length > 0;
    return { errors, patch: refused ? {} : patch };
}

/** `3 work sessions` - the same shape as the Companies warning, spelt here so this feature imports no other. */
export function describeSessionCount(count: number): string {
    return String(count) + (count === 1 ? ' work session' : ' work sessions');
}

/** Structurally a DialogRequest; declared here so this file pulls in no store and stays testable under node. */
export interface SettingsDialog {
    readonly tone: 'info' | 'error';
    readonly icon: string;
    readonly title: string;
    readonly body: string;
    readonly dismissLabel: string;
    readonly confirmLabel?: string;
    readonly destructive?: boolean;
}

/*
 * The one irreversible action in the app, and the reason the button carries DESTRUCTIVE_ACTION_ID:
 * legacy/pages/settings.html:659 reached it with document.querySelector('.mt-8.mb-8 button'), so a spacing tweak
 * detached the handler from the delete-all-data control - or attached it to whatever button a later edit put first.
 */
export const RESET_ALL_CONFIRM: SettingsDialog = {
    tone: 'error',
    icon: 'delete_forever',
    title: 'Delete All Sessions?',
    body: 'This will permanently delete every work session in your database, including any the timer is not ' +
        'counting right now. Companies and settings are kept. This action cannot be undone.',
    dismissLabel: 'Cancel',
    confirmLabel: 'Delete All',
    destructive: true
};

/** What actually went. `sessions:deleteAll` reports it, so the user is told a number rather than "Success!". */
export function describeDeleteAll(deletedSessionCount: number): string {
    return deletedSessionCount === 0
        ? 'There was no work session to delete.'
        : 'Deleted ' + describeSessionCount(deletedSessionCount) + '.';
}

/*
 * v1.2.1's About row opened github.com through window.open. The renderer refuses window.open now (WR-01, proved in
 * the packaged smoke) and there is no channel for opening a URL, so the address is shown as text.
 */
export const ABOUT: SettingsDialog = {
    tone: 'info',
    icon: 'info',
    title: 'Workflow Timer',
    body: 'Local-first work time tracking. Everything it records stays in a database on this machine. ' +
        'Source and releases: github.com/fleizean/workflow',
    dismissLabel: 'Close'
};

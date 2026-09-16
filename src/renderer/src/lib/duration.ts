// Elapsed seconds as HH:MM:SS, the way v1.2.1's clock read, and the one representation a duration is carried in.
// Integer arithmetic only: a duration is not a calendar date, and routing it through Date would drag in the UTC-day
// trap SHARED-03 exists to keep out.

import { MAX_SESSION_DURATION_SECONDS } from '@shared/constants/sessions';

const TWO_DIGITS = 2;
const PAD = '0';
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const MAX_HOURS = MAX_SESSION_DURATION_SECONDS / SECONDS_PER_HOUR;

/** Stated here because the minutes box carries it as `max` and this module is what enforces it. */
export const MINUTES_PER_HOUR = 60;

export function formatElapsed(totalSeconds: number): string {
    const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
    const hours = Math.floor(safe / SECONDS_PER_HOUR);
    const minutes = Math.floor((safe % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const seconds = safe % SECONDS_PER_MINUTE;
    return [hours, minutes, seconds].map((part) => String(part).padStart(TWO_DIGITS, PAD)).join(':');
}

/*
 * How a duration is typed, and why it is two integer boxes rather than a decimal hours field.
 *
 * TIMER CR-02 / SCREENS BL-01: both forms round-tripped a duration through `(seconds / 3600).toFixed(n)` and
 * `Math.floor(parseFloat(text) * 3600)`, so the stored value could not survive being shown. The save form lost or
 * invented up to 18 s on every save; the edit form moved a session by up to three minutes when the user had only
 * changed the note, and refused anything under three minutes outright.
 *
 * A duration is an integer number of seconds. The boxes are whole hours and whole minutes, so nothing the user can
 * type is a float, and a pair of boxes nobody typed into writes the seeded seconds back byte-identical - the same
 * rule settings-view.ts's reviewDraft follows for every other field.
 */
export interface DurationFields {
    readonly hours: string;
    readonly minutes: string;
}

/** The stored duration and the boxes it seeded, kept together so an untouched pair can be recognised. */
export interface SeededDuration {
    readonly seconds: number;
    readonly fields: DurationFields;
}

export function durationFields(totalSeconds: number): DurationFields {
    const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
    return {
        hours: String(Math.floor(safe / SECONDS_PER_HOUR)),
        minutes: String(Math.floor((safe % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE))
    };
}

export function seedDuration(totalSeconds: number): SeededDuration {
    const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
    return { seconds: safe, fields: durationFields(safe) };
}

/** An empty box is none of that unit; anything that is not a whole number is a refusal, never a silent zero. */
function wholeNumber(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') {
        return 0;
    }
    for (const character of trimmed) {
        if (character < '0' || character > '9') {
            return null;
        }
    }
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? value : null;
}

/** What the two boxes mean in seconds, or null when they do not mean anything. */
export function parseDurationFields(fields: DurationFields): number | null {
    const hours = wholeNumber(fields.hours);
    const minutes = wholeNumber(fields.minutes);
    if (hours === null || minutes === null || minutes >= MINUTES_PER_HOUR) {
        return null;
    }
    return hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE;
}

export interface DurationReview {
    /** The seconds to write, or null when there is nothing writable. */
    readonly seconds: number | null;
    /** Why it cannot be written, in the words the form shows. Null when it can. */
    readonly refusal: string | null;
}

export const DURATION_REFUSALS = {
    unreadable: 'Enter the duration as whole hours and whole minutes (0-59).',
    none: 'Enter how long this session was.',
    tooLong: 'A session cannot be longer than 24 hours.'
} as const;

/**
 * What a form should write, given what is in its boxes and what seeded them.
 *
 * The first branch is the whole point: a pair of boxes identical to the pair the stored value produced is a pair
 * nobody typed into, so the stored seconds go back exactly as they came - including the seconds no box can show.
 */
export function reviewDuration(typed: DurationFields, seeded: SeededDuration): DurationReview {
    const untouched = typed.hours === seeded.fields.hours && typed.minutes === seeded.fields.minutes;
    const seconds = untouched ? seeded.seconds : parseDurationFields(typed);
    if (seconds === null) {
        return { seconds: null, refusal: DURATION_REFUSALS.unreadable };
    }
    if (seconds <= 0) {
        return { seconds: null, refusal: DURATION_REFUSALS.none };
    }
    if (seconds > MAX_SESSION_DURATION_SECONDS) {
        return { seconds: null, refusal: DURATION_REFUSALS.tooLong };
    }
    return { seconds, refusal: null };
}

/** What the hours box states as its own bound, which is the contract's cap expressed in that box's unit. */
export const MAX_DURATION_HOURS = MAX_HOURS;

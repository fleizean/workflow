// v1.2.1's display formatters, as pure functions. legacy/renderer/shared.js built them out of `new Date(dateStr)`,
// which reads YYYY-MM-DD as UTC midnight and then asks it local questions - west of Greenwich every date badge and
// every created-on line showed the day before. Calendar days go through @shared/utils/date instead (SHARED-03).

import { instantFromEpochMs, isoWeekday, localDateParts, parseLocalDate } from '@shared/utils/date';
import type { LocalDate } from '@shared/types';

/** Indexed by isoWeekday - 1, so 1 = Monday. legacy/renderer/shared.js:17 spells them the same way. */
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const TWO_DIGITS = 2;
const PAD = '0';

export interface DayBadge {
    readonly weekday: string;
    /** Unpadded, as legacy/renderer/shared.js:20's getDate() returned it. */
    readonly day: string;
}

/** legacy/renderer/shared.js:6 - `08h 30m`, padded on both halves. */
export function formatDurationShort(totalSeconds: number): string {
    const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    return String(hours).padStart(TWO_DIGITS, PAD) + 'h ' + String(minutes).padStart(TWO_DIGITS, PAD) + 'm';
}

/**
 * PANEL-03: `3h 12m`, `8h`, `12m`. The unpadded sibling of formatDurationShort, which pads both halves because
 * that is what v1.2.1 drew (`08h 30m`) and what Work History still has to match. A flag on that one would have put
 * a parity-pinned formatter in the business of answering two questions, so this is a second function and says so.
 * A whole number of hours drops the minutes, because `8h 00m` reads as a measurement rather than as a target.
 */
export function formatHoursMinutes(totalSeconds: number): string {
    const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    if (hours === 0) {
        return String(minutes) + 'm';
    }
    return minutes === 0 ? String(hours) + 'h' : String(hours) + 'h ' + String(minutes) + 'm';
}

export function formatDayBadge(date: LocalDate): DayBadge {
    return {
        weekday: WEEKDAY_NAMES[isoWeekday(date) - 1] ?? '',
        day: String(localDateParts(date).day)
    };
}

/** `Sep 13, 2026` - the shape v1.2.1 asked Intl for on both screens. */
export function formatLongDay(date: LocalDate): string {
    return parseLocalDate(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** `Sep 13` - the two ends of a week range. */
export function formatShortDay(date: LocalDate): string {
    return parseLocalDate(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** An instant, not a day: a row's created_at, shown as the date it was created on. */
export function formatCreatedOn(epochMs: number): string {
    return instantFromEpochMs(epochMs)
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * An instant as a 24-hour clock time. v1.2.1 asked for the tr-TR locale with hour12 false
 * (legacy/pages/work-history.html:678); kept verbatim, because what it produces is HH:MM either way.
 */
export function formatClockTime(epochMs: number): string {
    return instantFromEpochMs(epochMs)
        .toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

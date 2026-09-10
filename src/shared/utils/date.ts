// The one calendar-day module (SHARED-01..03). Only formatLocalDate and parseLocalDate consult the host zone.
// Import-free and erasable-syntax only: the zone sweep loads this file through Node's type stripping.

export type LocalDate = string & { readonly __brand: 'LocalDate' };

export interface LocalDateParts {
    readonly year: number;
    readonly month: number;
    readonly day: number;
}

// No m flag, so $ cannot match before a trailing newline; no u flag, so \d is ASCII only.
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function partsOf(value: unknown): LocalDateParts | undefined {
    if (typeof value !== 'string') return undefined;
    const match = LOCAL_DATE.exec(value);
    if (match === null) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
    return { year, month, day };
}

function pad(value: number, width: number): string {
    return String(value).padStart(width, '0');
}

function format(year: number, month: number, day: number): LocalDate {
    return (pad(year, 4) + '-' + pad(month, 2) + '-' + pad(day, 2)) as LocalDate;
}

function describe(value: unknown): string {
    if (typeof value === 'string') return 'string ' + JSON.stringify(value);
    if (value === null) return 'null';
    if (value instanceof Date) return 'a Date object';
    if (typeof value === 'number') return 'number ' + String(value);
    return typeof value;
}

export function isLocalDate(value: unknown): value is LocalDate {
    return partsOf(value) !== undefined;
}

export function formatLocalDate(instant: Date): LocalDate {
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
        throw new Error('formatLocalDate: expected a valid Date, got ' + describe(instant));
    }
    return format(instant.getFullYear(), instant.getMonth() + 1, instant.getDate());
}

/** Local midnight of the day, for Intl and display APIs only - never for arithmetic. */
export function parseLocalDate(text: string): Date {
    const parts = partsOf(text);
    if (parts === undefined) {
        throw new Error('parseLocalDate: expected a real YYYY-MM-DD day, got ' + describe(text));
    }
    const local = new Date(2000, 0, 1);
    // setFullYear, not the constructor: a two-digit year argument means 1900 + year.
    local.setFullYear(parts.year, parts.month - 1, parts.day);
    // On a day whose local midnight is skipped this lands at 01:00 of the same day.
    local.setHours(0, 0, 0, 0);
    return local;
}

/** An instant, never a calendar day (D-05). */
export function utcIsoTimestamp(instant: Date): string {
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
        throw new Error('utcIsoTimestamp: expected a valid Date, got ' + describe(instant));
    }
    return instant.toISOString();
}

/** An instant, never a calendar day (D-05). */
export function instantFromEpochMs(ms: number): Date {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw new Error('instantFromEpochMs: expected a finite number, got ' + describe(ms));
    }
    return new Date(ms);
}

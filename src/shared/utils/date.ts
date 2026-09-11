// The one calendar-day module (SHARED-01..03). Only formatLocalDate and parseLocalDate consult the host zone.
// Import-free and erasable-syntax only: the zone sweep loads this file through Node's type stripping.

export type LocalDate = string & { readonly __brand: 'LocalDate' };

export interface LocalDateParts {
    readonly year: number;
    readonly month: number;
    readonly day: number;
}

export type WeekBucket = 'thisWeek' | 'lastWeek' | 'older';

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

// Howard Hinnant's days_from_civil / civil_from_days: an integer day serial, 0 = 1970-01-01, no Date involved.
function dayNumber(parts: LocalDateParts): number {
    const y = parts.month <= 2 ? parts.year - 1 : parts.year;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * ((parts.month + 9) % 12) + 2) / 5) + parts.day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

function fromDayNumber(serial: number): LocalDate {
    const z = serial + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    return format(yoe + era * 400 + (month <= 2 ? 1 : 0), month, day);
}

const MIN_SERIAL = dayNumber({ year: 1, month: 1, day: 1 });
const MAX_SERIAL = dayNumber({ year: 9999, month: 12, day: 31 });

// The brand is compile-time only; untyped callers reach these functions too.
function partsOrThrow(value: unknown, fn: string): LocalDateParts {
    const parts = partsOf(value);
    if (parts === undefined) throw new Error(fn + ': expected a LocalDate YYYY-MM-DD, got ' + describe(value));
    return parts;
}

function serialOf(value: unknown, fn: string): number {
    return dayNumber(partsOrThrow(value, fn));
}

// 1 = Monday .. 7 = Sunday; serial 0 was a Thursday.
function weekdayOf(serial: number): number {
    return ((serial % 7) + 10) % 7 + 1;
}

export function isLocalDate(value: unknown): value is LocalDate {
    return partsOf(value) !== undefined;
}

export function formatLocalDate(instant: Date): LocalDate {
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
        throw new Error('formatLocalDate: expected a valid Date, got ' + describe(instant));
    }
    const year = instant.getFullYear();
    // The addDays bound: every LocalDate this module mints must pass isLocalDate.
    if (year < 1 || year > 9999) {
        throw new Error('formatLocalDate: local year ' + String(year) + ' falls outside 0001..9999');
    }
    return format(year, instant.getMonth() + 1, instant.getDate());
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

export function localDateParts(date: LocalDate): LocalDateParts {
    return partsOrThrow(date, 'localDateParts');
}

export function addDays(date: LocalDate, days: number): LocalDate {
    const start = serialOf(date, 'addDays');
    if (!Number.isSafeInteger(days)) {
        throw new Error('addDays: expected a whole number of days, got ' + describe(days));
    }
    const serial = start + days;
    if (serial < MIN_SERIAL || serial > MAX_SERIAL) {
        throw new Error('addDays: ' + date + ' + ' + String(days) + ' days falls outside 0001-01-01..9999-12-31');
    }
    return fromDayNumber(serial);
}

export function diffDays(later: LocalDate, earlier: LocalDate): number {
    return serialOf(later, 'diffDays') - serialOf(earlier, 'diffDays');
}

export function isoWeekday(date: LocalDate): number {
    return weekdayOf(serialOf(date, 'isoWeekday'));
}

export function startOfWeek(date: LocalDate): LocalDate {
    const serial = serialOf(date, 'startOfWeek');
    return fromDayNumber(serial + 1 - weekdayOf(serial));
}

export function isSameDay(a: LocalDate, b: LocalDate): boolean {
    return serialOf(a, 'isSameDay') === serialOf(b, 'isSameDay');
}

// Total: a date after the current week stays in thisWeek, so no session can vanish from History (D-02).
export function weekBucketOf(date: LocalDate, today: LocalDate): WeekBucket {
    const day = serialOf(date, 'weekBucketOf');
    const now = serialOf(today, 'weekBucketOf');
    const monday = now + 1 - weekdayOf(now);
    if (day >= monday) return 'thisWeek';
    return day >= monday - 7 ? 'lastWeek' : 'older';
}

/** An instant, never a calendar day (D-05). */
export function utcIsoTimestamp(instant: Date): string {
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
        throw new Error('utcIsoTimestamp: expected a valid Date, got ' + describe(instant));
    }
    return instant.toISOString();
}

// Beyond the ECMAScript time range new Date() returns an Invalid Date rather than throwing.
const MAX_EPOCH_MS = 8.64e15;

/** An instant, never a calendar day (D-05). */
export function instantFromEpochMs(ms: number): Date {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) {
        throw new Error('instantFromEpochMs: expected a finite number within +/-8.64e15 ms, got ' + describe(ms));
    }
    return new Date(ms);
}

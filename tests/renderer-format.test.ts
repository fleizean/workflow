/*
 * src/renderer/src/lib/format.ts - v1.2.1's display formatters, as functions a test can run.
 *
 * There is no jsdom in this project and no test renders a component, so a screen is proved through the pure modules
 * it is assembled from. These are the ones both Companies and Work History read every value through.
 *
 * The zone question is not asked again here: formatDayBadge, formatLongDay and formatShortDay go through
 * isoWeekday, localDateParts and parseLocalDate, and tests/date-zone-sweep.test.ts already runs those across twelve
 * zones in child processes with an explicit TZ. What this file adds is the shape of the output and the one control
 * that says why the legacy formulas were replaced at all.
 */

import { describe, expect, it } from 'vitest';
import {
    formatClockTime, formatCreatedOn, formatDayBadge, formatDurationShort, formatLongDay, formatShortDay
} from '@renderer/lib/format';
import { instantFromEpochMs } from '@shared/utils/date';
import type { LocalDate } from '@shared/types';

const day = (value: string): LocalDate => value as LocalDate;

describe('formatDurationShort: legacy/renderer/shared.js:6, padded on both halves', () => {
    it.each([
        [0, '00h 00m'],
        [59, '00h 00m'],
        [60, '00h 01m'],
        [3600, '01h 00m'],
        [30600, '08h 30m'],
        [86400, '24h 00m'],
        // A v1.2.1 row can hold more than a day, because v1.2.1 counted time while the app was closed (B12).
        [180000, '50h 00m']
    ])('%i seconds reads as %s', (seconds, expected) => {
        expect(formatDurationShort(seconds)).toBe(expected);
    });

    it('answers zero rather than NaN for a value that is not a duration', () => {
        expect(formatDurationShort(Number.NaN)).toBe('00h 00m');
        expect(formatDurationShort(-1)).toBe('00h 00m');
    });
});

describe('formatDayBadge: the weekday and the day number the date badge shows', () => {
    it.each([
        ['2026-09-14', 'Mon', '14'],
        ['2026-09-15', 'Tue', '15'],
        ['2026-09-16', 'Wed', '16'],
        ['2026-09-17', 'Thu', '17'],
        ['2026-09-18', 'Fri', '18'],
        ['2026-09-19', 'Sat', '19'],
        ['2026-09-20', 'Sun', '20']
    ])('%s is %s %s', (date, weekday, number) => {
        expect(formatDayBadge(day(date))).toEqual({ weekday, day: number });
    });

    it('leaves the day number unpadded, as getDate() returned it', () => {
        expect(formatDayBadge(day('2026-09-09')).day).toBe('9');
    });

    it('names the day for every date in a year, so the weekday cycle is not a lucky seven', () => {
        const NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        let index = NAMES.indexOf('Thu'); // 2026-01-01
        for (let ordinal = 1; ordinal <= 365; ordinal += 1) {
            const date = instantFromEpochMs(Date.UTC(2026, 0, ordinal));
            const iso = date.toLocaleDateString('en-CA', { timeZone: 'UTC' });
            expect(formatDayBadge(day(iso)).weekday).toBe(NAMES[index]);
            index = (index + 1) % NAMES.length;
        }
    });

    /*
     * The control. legacy/renderer/shared.js:16 read the badge off `new Date('2026-09-13')`, which the language
     * parses as UTC midnight and then answered with local getters - so west of Greenwich the badge showed the day
     * before, every day. Asserted only where the host zone is actually west of UTC, because that is the only place
     * the claim is about: the point is that the OLD formula depended on the reader's zone and the new one does not.
     */
    it('does not read a local day off a UTC instant, which is what the old formula did', () => {
        const utcMidnight = instantFromEpochMs(Date.UTC(2026, 8, 13));
        expect(formatDayBadge(day('2026-09-13'))).toEqual({ weekday: 'Sun', day: '13' });
        if (utcMidnight.getTimezoneOffset() > 0) {
            expect(
                String(utcMidnight.getDate()),
                'the host zone is west of UTC, so legacy/renderer/shared.js:16 read 2026-09-13 as the 12th'
            ).toBe('12');
        }
    });
});

describe('the Intl formatters ask for the shapes v1.2.1 asked for', () => {
    it('formatLongDay is month, day, year', () => {
        expect(formatLongDay(day('2026-09-13'))).toBe('Sep 13, 2026');
        expect(formatLongDay(day('2026-01-01'))).toBe('Jan 1, 2026');
    });

    it('formatShortDay is month and day, which is what a week range is written with', () => {
        expect(formatShortDay(day('2026-09-14'))).toBe('Sep 14');
        expect(formatShortDay(day('2026-09-20'))).toBe('Sep 20');
    });

    it('formatCreatedOn reads an instant as the local day it fell on', () => {
        const localNoon = new Date(2026, 8, 13, 12, 0, 0).getTime();
        expect(formatCreatedOn(localNoon)).toBe('Sep 13, 2026');
    });

    it('formatClockTime reads an instant as a 24-hour local clock', () => {
        expect(formatClockTime(new Date(2026, 8, 13, 14, 30, 0).getTime())).toBe('14:30');
        expect(formatClockTime(new Date(2026, 8, 13, 9, 5, 0).getTime())).toBe('09:05');
        expect(formatClockTime(new Date(2026, 8, 13, 0, 0, 0).getTime())).toBe('00:00');
    });
});

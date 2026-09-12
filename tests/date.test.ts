// In-process date.ts tables (SHARED-01/02, D-02..D-04, D-10). They run in every CI zone and must agree in all of them.
// Test instants come only from the multi-argument Date constructor, Date.UTC and instantFromEpochMs.

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { read } from './helpers/ts-imports';
import {
    addDays,
    diffDays,
    epochMsFromSqlTimestamp,
    formatLocalDate,
    instantFromEpochMs,
    isLocalDate,
    isoWeekday,
    isSameDay,
    localDateParts,
    parseLocalDate,
    startOfWeek,
    utcIsoTimestamp,
    weekBucketOf,
    type LocalDate,
    type WeekBucket
} from '../src/shared/utils/date';

const ld = (text: string): LocalDate => text as LocalDate;

// Every day of [firstYear, lastYear], days per month from the multi-argument constructor (independent of date.ts).
function oracleDays(firstYear: number, lastYear: number): LocalDate[] {
    const days: LocalDate[] = [];
    for (let year = firstYear; year <= lastYear; year++) {
        for (let month = 1; month <= 12; month++) {
            const length = new Date(year, month, 0).getDate();
            for (let day = 1; day <= length; day++) {
                days.push(ld(String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' +
                    String(day).padStart(2, '0')));
            }
        }
    }
    return days;
}

const SWEEP_DAYS = oracleDays(2020, 2030);

describe('strict parsing (SHARED-01, D-04)', () => {
    const ACCEPTED = ['2026-09-05', '2024-02-29', '2000-02-29', '0001-01-01', '9999-12-31'];

    const REJECTED: [string, unknown][] = [
        ['non-padded', '2026-9-5'],
        ['impossible day', '2026-02-30'],
        ['Feb 29 in a common year', '2025-02-29'],
        ['Feb 29 in a century common year', '2100-02-29'],
        ['day 00', '2026-09-00'],
        ['time suffix', '2026-09-05T00:00'],
        ['leading space', ' 2026-09-05'],
        ['trailing space', '2026-09-05 '],
        ['trailing newline', '2026-09-05\n'],
        ['full-width digits', '２０２６-０９-０５'],
        ['year 0000', '0000-01-01'],
        ['month 13', '2026-13-01'],
        ['month 00', '2026-00-10'],
        ['empty string', ''],
        ['a Date object', new Date(2026, 8, 5)],
        ['null', null],
        ['undefined', undefined],
        ['a number', 20260905]
    ];

    it.each(ACCEPTED)('accepts %s and round-trips it', (text) => {
        expect(isLocalDate(text), 'SHARED-01: isLocalDate(' + text + ')').toBe(true);
        expect(formatLocalDate(parseLocalDate(text)), 'SHARED-01: round trip of ' + text).toBe(text);
    });

    it.each(REJECTED)('rejects %s: parseLocalDate throws, isLocalDate is false', (_label, value) => {
        expect(() => parseLocalDate(value as string), 'SHARED-01: parseLocalDate must throw')
            .toThrow(/^parseLocalDate: expected a real YYYY-MM-DD day, got /);
        expect(isLocalDate(value), 'SHARED-01: isLocalDate verdict').toBe(false);
    });

    it('builds years below 100 without the two-digit-year trap', () => {
        expect(parseLocalDate('0099-01-01').getFullYear(), 'SHARED-01: year 99 is not 1999').toBe(99);
        expect(localDateParts(ld('0099-01-01')), 'SHARED-01: parts of 0099-01-01').toEqual({ year: 99, month: 1, day: 1 });
    });

    it('formatLocalDate refuses an invalid Date and a non-Date', () => {
        expect(() => formatLocalDate(new Date(Number.NaN, 0)), 'SHARED-01: invalid Date')
            .toThrow(/^formatLocalDate: expected a valid Date/);
        expect(() => formatLocalDate('2026-09-05' as unknown as Date), 'SHARED-01: string cast to Date')
            .toThrow(/^formatLocalDate: expected a valid Date/);
    });

    // WR-01: the inside edges, 0001-01-01 and 9999-12-31, round-trip in ACCEPTED above.
    it('formatLocalDate refuses an instant whose local year falls outside 0001..9999', () => {
        const yearZero = new Date(2000, 0, 1);
        yearZero.setFullYear(0, 5, 15);
        const year10000 = new Date(2000, 0, 1);
        year10000.setFullYear(10000, 0, 1);
        const outside: [string, Date][] = [
            ['year 0', yearZero],
            ['year 10000', year10000],
            ['the last valid instant', instantFromEpochMs(8.64e15)],
            ['the first valid instant', instantFromEpochMs(-8.64e15)]
        ];
        for (const [label, instant] of outside) {
            expect(() => formatLocalDate(instant), 'WR-01: ' + label + ' would mint a LocalDate isLocalDate rejects')
                .toThrow(/^formatLocalDate: local year -?\d+ falls outside 0001\.\.9999$/);
        }
    });
});

describe('calendar arithmetic (SHARED-02, D-03)', () => {
    it('round-trips and steps through every day 2020-2030 (4018 days)', () => {
        const failures: string[] = [];
        let checked = 0;
        let previous: LocalDate | undefined;
        for (const day of SWEEP_DAYS) {
            checked++;
            if (formatLocalDate(parseLocalDate(day)) !== day) failures.push('round trip ' + day);
            if (previous !== undefined) {
                if (addDays(previous, 1) !== day) failures.push('addDays(' + previous + ', 1)');
                if (addDays(day, -1) !== previous) failures.push('addDays(' + day + ', -1)');
                if (diffDays(day, previous) !== 1) failures.push('diffDays(' + day + ', ' + previous + ')');
            }
            previous = day;
        }
        expect(checked, 'SHARED-01: 2020-2030 has 4018 days').toBe(4018);
        expect(failures.slice(0, 20), 'SHARED-01/02: day-by-day failures').toEqual([]);
    });

    it.each([
        ['2024-02-28', 1, '2024-02-29'],
        ['2023-02-28', 1, '2023-03-01'],
        ['2100-02-28', 1, '2100-03-01'],
        ['2000-02-28', 1, '2000-02-29'],
        ['2026-01-31', 1, '2026-02-01'],
        ['2026-12-31', 1, '2027-01-01'],
        ['2027-01-01', -1, '2026-12-31'],
        ['2026-10-26', 7, '2026-11-02'],
        ['2026-03-09', -7, '2026-03-02'],
        ['2024-02-29', 365, '2025-02-28'],
        ['2026-09-05', 0, '2026-09-05'],
        ['0001-01-01', 3652058, '9999-12-31']
    ] as [string, number, string][])('addDays(%s, %i) = %s', (from, days, expected) => {
        expect(addDays(ld(from), days), 'SHARED-02: addDays').toBe(expected);
    });

    it.each([
        ['2027-01-01', '2026-12-31', 1],
        ['2026-11-02', '2026-10-26', 7],
        ['2026-03-09', '2026-03-02', 7],
        ['2026-09-05', '2026-09-05', 0],
        ['2026-10-26', '2026-11-02', -7],
        ['9999-12-31', '0001-01-01', 3652058]
    ] as [string, string, number][])('diffDays(%s, %s) = %i', (later, earlier, expected) => {
        expect(diffDays(ld(later), ld(earlier)), 'SHARED-02: diffDays').toBe(expected);
    });

    it.each([
        ['a fraction', '2026-09-05', 1.5],
        ['NaN', '2026-09-05', Number.NaN],
        ['Infinity', '2026-09-05', Number.POSITIVE_INFINITY],
        ['past 9999-12-31', '9999-12-31', 1],
        ['before 0001-01-01', '0001-01-01', -1]
    ] as [string, string, number][])('addDays throws for %s', (_label, from, days) => {
        expect(() => addDays(ld(from), days), 'SHARED-02: the result must still be a LocalDate').toThrow(/^addDays: /);
    });

    it.each([
        ['localDateParts', (bad: LocalDate) => localDateParts(bad)],
        ['addDays', (bad: LocalDate) => addDays(bad, 1)],
        ['diffDays', (bad: LocalDate) => diffDays(bad, ld('2026-09-05'))],
        ['diffDays', (bad: LocalDate) => diffDays(ld('2026-09-05'), bad)],
        ['isoWeekday', (bad: LocalDate) => isoWeekday(bad)],
        ['startOfWeek', (bad: LocalDate) => startOfWeek(bad)],
        ['isSameDay', (bad: LocalDate) => isSameDay(bad, ld('2026-09-05'))],
        ['weekBucketOf', (bad: LocalDate) => weekBucketOf(bad, ld('2026-09-05'))],
        ['weekBucketOf', (bad: LocalDate) => weekBucketOf(ld('2026-09-05'), bad)]
    ] as [string, (bad: LocalDate) => unknown][])('%s re-validates an unbranded input at runtime', (name, call) => {
        for (const bad of ['2026-9-5', '2026-02-30', ' 2026-09-05']) {
            expect(() => call(ld(bad)), 'SHARED-02: ' + name + '(' + JSON.stringify(bad) + ')')
                .toThrow(new RegExp('^' + name + ': expected a LocalDate YYYY-MM-DD, got '));
        }
    });

    it('localDateParts returns year, month 1-12 and day', () => {
        expect(localDateParts(ld('2026-09-05')), 'SHARED-02: parts').toEqual({ year: 2026, month: 9, day: 5 });
    });

    it.each([
        ['2026-09-07', 1],
        ['2026-09-10', 4],
        ['2026-09-13', 7],
        ['2000-01-01', 6],
        ['1970-01-01', 4],
        ['0001-01-01', 1]
    ] as [string, number][])('isoWeekday(%s) = %i (Monday 1 .. Sunday 7)', (day, expected) => {
        expect(isoWeekday(ld(day)), 'SHARED-02: isoWeekday').toBe(expected);
    });

    it.each([
        ['2026-09-13', '2026-09-07'],
        ['2026-09-07', '2026-09-07'],
        ['2027-01-01', '2026-12-28'],
        ['2026-11-01', '2026-10-26'],
        ['2026-03-08', '2026-03-02']
    ])('startOfWeek(%s) = %s', (day, monday) => {
        expect(startOfWeek(ld(day)), 'SHARED-02: Monday-based week (D-02)').toBe(monday);
    });

    it('isSameDay compares calendar days', () => {
        expect(isSameDay(ld('2026-09-05'), ld('2026-09-05')), 'SHARED-02: same day').toBe(true);
        expect(isSameDay(ld('2026-09-05'), ld('2026-09-06')), 'SHARED-02: different day').toBe(false);
    });
});

describe('week buckets (SHARED-02, D-02)', () => {
    it.each([
        ['2026-09-07', '2026-09-10', 'thisWeek'],
        ['2026-09-13', '2026-09-10', 'thisWeek'],
        ['2026-09-20', '2026-09-10', 'thisWeek'],
        ['2026-09-06', '2026-09-10', 'lastWeek'],
        ['2026-08-31', '2026-09-10', 'lastWeek'],
        ['2026-08-30', '2026-09-10', 'older'],
        ['2026-12-28', '2027-01-01', 'thisWeek'],
        ['2026-12-21', '2027-01-01', 'lastWeek'],
        ['2026-12-20', '2027-01-01', 'older'],
        ['2026-10-26', '2026-11-04', 'lastWeek'],
        ['2026-11-01', '2026-11-04', 'lastWeek'],
        ['2026-10-25', '2026-11-04', 'older'],
        ['2026-03-02', '2026-03-11', 'lastWeek'],
        ['2026-03-08', '2026-03-11', 'lastWeek'],
        ['2026-03-01', '2026-03-11', 'older']
    ] as [string, string, WeekBucket][])('weekBucketOf(%s, today %s) = %s', (day, today, expected) => {
        expect(weekBucketOf(ld(day), ld(today)), 'SHARED-02: bucket').toBe(expected);
    });

    it.each(['2020-01-01', '2026-09-10', '2030-12-31'])('is total and ordered for every day 2020-2030 with today %s', (today) => {
        const rank: Record<WeekBucket, number> = { older: 0, lastWeek: 1, thisWeek: 2 };
        const problems: string[] = [];
        let previousRank = 0;
        for (const day of SWEEP_DAYS) {
            const bucket = weekBucketOf(day, ld(today));
            if (!(bucket in rank)) {
                problems.push(day + ' -> ' + String(bucket));
                continue;
            }
            if (rank[bucket] < previousRank) problems.push(day + ' moved back to ' + bucket);
            previousRank = rank[bucket];
        }
        expect(problems.slice(0, 20), 'SHARED-02: every day gets exactly one bucket, oldest first (D-02)').toEqual([]);
    });
});

describe('instant helpers (D-05)', () => {
    it('formats a UTC instant and refuses non-finite epoch values', () => {
        expect(utcIsoTimestamp(instantFromEpochMs(Date.UTC(2026, 8, 6, 10, 0, 0))), 'D-05: UTC instant stamp')
            .toBe('2026-09-06T10:00:00.000Z');
        expect(() => instantFromEpochMs(Number.NaN), 'D-05: NaN').toThrow(/^instantFromEpochMs: expected a finite number/);
        expect(() => instantFromEpochMs(Number.POSITIVE_INFINITY), 'D-05: Infinity')
            .toThrow(/^instantFromEpochMs: expected a finite number/);
        expect(() => utcIsoTimestamp(new Date(Number.NaN, 0)), 'D-05: invalid Date')
            .toThrow(/^utcIsoTimestamp: expected a valid Date/);
    });

    it('refuses an epoch value outside the Date range instead of returning an Invalid Date (WR-01)', () => {
        expect(instantFromEpochMs(8.64e15).getTime(), 'WR-01: the last valid instant').toBe(8.64e15);
        expect(instantFromEpochMs(-8.64e15).getTime(), 'WR-01: the first valid instant').toBe(-8.64e15);
        for (const ms of [8.64e15 + 1, -8.64e15 - 1, 1e16, -1e16]) {
            expect(() => instantFromEpochMs(ms), 'WR-01: ' + String(ms) + ' ms is outside the Date range')
                .toThrow(/^instantFromEpochMs: expected a finite number/);
        }
    });
});


describe('stored SQLite timestamps (D-05)', () => {
    // Date.UTC is an oracle independent of date.ts: it never consults the host zone.
    const CASES: [string, number][] = [
        ['2026-01-05 09:00:00', Date.UTC(2026, 0, 5, 9, 0, 0)],
        ['2026-12-31 23:59:59', Date.UTC(2026, 11, 31, 23, 59, 59)],
        ['1970-01-01 00:00:00', 0],
        ['2024-02-29 12:00:00', Date.UTC(2024, 1, 29, 12, 0, 0)],
        ['2026-01-05T09:00:00Z', Date.UTC(2026, 0, 5, 9, 0, 0)],
        ['2026-01-05T09:00:00.250Z', Date.UTC(2026, 0, 5, 9, 0, 0, 250)],
        ['2026-01-05 09:00:00.5', Date.UTC(2026, 0, 5, 9, 0, 0, 500)]
    ];

    it.each(CASES)('reads %s as the UTC instant it is', (text, expected) => {
        expect(epochMsFromSqlTimestamp(text)).toBe(expected);
    });

    it('agrees with instantFromEpochMs on the round trip', () => {
        expect(utcIsoTimestamp(instantFromEpochMs(epochMsFromSqlTimestamp('2026-09-06 10:00:00'))))
            .toBe('2026-09-06T10:00:00.000Z');
    });

    it('does not shift a year below 0100 (the Date.UTC two-digit-year trap)', () => {
        expect(epochMsFromSqlTimestamp('0099-01-01 00:00:00'), 'Date.UTC(99, ...) would mean 1999')
            .toBeLessThan(epochMsFromSqlTimestamp('1900-01-01 00:00:00'));
    });

    const REJECTED: [string, unknown][] = [
        ['a calendar day alone', '2026-01-05'],
        ['an unpadded hour', '2026-01-05 9:00:00'],
        ['a day that does not exist', '2026-02-30 09:00:00'],
        ['hour 24', '2026-01-05 24:00:00'],
        ['minute 60', '2026-01-05 09:60:00'],
        ['second 60', '2026-01-05 09:00:60'],
        ['a US date', '05/01/2026 09:00:00'],
        ['an empty string', ''],
        ['a trailing newline', '2026-01-05 09:00:00\n'],
        ['a number', 20260105],
        ['null', null]
    ];

    it.each(REJECTED)('refuses %s rather than inventing an instant', (_label, value) => {
        expect(() => epochMsFromSqlTimestamp(value as string)).toThrow(/^epochMsFromSqlTimestamp:/);
    });
});

// D-03/D-04 structure: only these functions may touch Date; nothing may read the clock.
const DATE_EXEMPT = new Set(['formatLocalDate', 'parseLocalDate', 'utcIsoTimestamp', 'instantFromEpochMs', 'describe']);
const CALENDAR_FUNCTIONS = ['localDateParts', 'addDays', 'diffDays', 'isoWeekday', 'startOfWeek', 'isSameDay', 'weekBucketOf'];

interface DateScan {
    checked: string[];
    exemptFound: string[];
    zoneFindings: string[];
    clockFindings: string[];
}

function functionName(node: ts.Node): string | undefined {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) return node.name.text;
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        return node.parent.name.text;
    }
    return undefined;
}

function memberName(node: ts.Node): string | undefined {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        return node.argumentExpression.text;
    }
    return undefined;
}

function isDateIdentifier(node: ts.Node): boolean {
    return ts.isIdentifier(node) && node.text === 'Date';
}

function scanDateModule(source: string): DateScan {
    const sourceFile = ts.createSourceFile('date.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const scan: DateScan = { checked: [], exemptFound: [], zoneFindings: [], clockFindings: [] };
    const where = (node: ts.Node, owner: string | undefined): string =>
        (owner ?? '<module>') + ' line ' + String(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1);

    const visit = (node: ts.Node, owner: string | undefined): void => {
        const name = functionName(node);
        const current = name ?? owner;
        if (name !== undefined) (DATE_EXEMPT.has(name) ? scan.exemptFound : scan.checked).push(name);

        if (current === undefined || !DATE_EXEMPT.has(current)) {
            if (isDateIdentifier(node)) scan.zoneFindings.push(where(node, current) + ': Date');
            const member = memberName(node);
            if (member !== undefined && (member === 'getTime' || member.startsWith('getUTC'))) {
                scan.zoneFindings.push(where(node, current) + ': ' + member);
            }
        }
        if (memberName(node) === 'now' && isDateIdentifier((node as ts.PropertyAccessExpression).expression)) {
            scan.clockFindings.push(where(node, current) + ': Date.now');
        }
        if (ts.isNewExpression(node) && isDateIdentifier(node.expression) && (node.arguments?.length ?? 0) === 0) {
            scan.clockFindings.push(where(node, current) + ': zero-argument Date construction');
        }
        if (ts.isCallExpression(node) && isDateIdentifier(node.expression)) {
            scan.clockFindings.push(where(node, current) + ': Date() call');
        }
        ts.forEachChild(node, (child) => visit(child, current));
    };
    visit(sourceFile, undefined);
    return scan;
}

describe('date.ts structure (SHARED-02 D-03, D-04)', () => {
    it('keeps Date, getTime and getUTC* out of every calendar function, and never reads the clock', () => {
        const scan = scanDateModule(read('src/shared/utils/date.ts'));
        expect(scan.checked, 'SHARED-02: the calendar functions must exist to be checked')
            .toEqual(expect.arrayContaining(CALENDAR_FUNCTIONS));
        expect(scan.exemptFound.sort(), 'D-03: every exemption names a real function')
            .toEqual([...DATE_EXEMPT].sort());
        expect(scan.zoneFindings, 'SHARED-02/D-03: zone-dependent access outside the exempt functions; checked ' +
            scan.checked.join(', ')).toEqual([]);
        expect(scan.clockFindings, 'D-04: date.ts must never read the clock').toEqual([]);
    });

    it('negative control: the scanner reports each forbidden form', () => {
        const scan = scanDateModule([
            'export function addDays(d: string): number { return new Date(2026, 0, 1).getTime() + d.length; }',
            'export function isoWeekday(d: { getUTCDay(): number }): number { return d.getUTCDay(); }',
            'export function formatLocalDate(): number { return Date.now() + new Date().getDate() + Date().length; }'
        ].join('\n'));
        expect(scan.zoneFindings.join('; '), 'the scanner must see Date in addDays').toMatch(/addDays line 1: Date/);
        expect(scan.zoneFindings.join('; '), 'the scanner must see getTime').toMatch(/addDays line 1: getTime/);
        expect(scan.zoneFindings.join('; '), 'the scanner must see getUTC*').toMatch(/isoWeekday line 2: getUTCDay/);
        expect(scan.clockFindings, 'the scanner must see every clock read, even in an exempt function').toHaveLength(3);
    });
});

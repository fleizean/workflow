// CORE-08: the streak and the day and week totals. Pure functions over day totals - the tables below pass them
// literals, and the B7 group feeds them a real fixture database through the sessions repository.

import { afterAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import { createDbHandle } from '../src/lib/db/handle';
import { createSessionsRepository } from '../src/lib/db/repositories';
import { currentStreak, isGoalMet, totalForDay, weekTotals } from '../src/main/services/stats.service';
import { formatLocalDate, startOfWeek } from '../src/shared/utils/date';
import { cleanupFixtures, makeEmptyFixture } from './fixtures/seed';
import type { DayTotal, LocalDate } from '../src/shared/types';

// Criterion 3: this suite must pass with electron refusing to load. tests/services-electron-free.test.ts requires
// the call in every test that imports a service, and would report this file the day it went missing.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

const ld = (text: string): LocalDate => text as LocalDate;
const day = (date: string, totalSeconds: number): DayTotal => ({ date: ld(date), totalSeconds });

const TARGET = 28800;
const EIGHT_HOUR_WEEK = { dailyTargetSeconds: TARGET, excludeWeekends: false };

afterAll(cleanupFixtures);

describe('CORE-08: the day total', () => {
    const totals = [day('2026-03-02', 28800), day('2026-03-03', 3600)];

    it('is the day total, and zero rather than null for a day with nothing on it', () => {
        expect(totalForDay(totals, ld('2026-03-02'))).toBe(28800);
        expect(totalForDay(totals, ld('2026-03-04')), 'DATA-05: never null').toBe(0);
        expect(totalForDay([], ld('2026-03-04'))).toBe(0);
    });

    it('decides the goal from the day, and reads a missing day as unmet', () => {
        expect(isGoalMet(totals, ld('2026-03-02'), TARGET)).toBe(true);
        expect(isGoalMet(totals, ld('2026-03-03'), TARGET)).toBe(false);
        expect(isGoalMet(totals, ld('2026-03-04'), TARGET)).toBe(false);
        expect(isGoalMet(totals, ld('2026-03-02'), 28801), 'the target is a floor, not a ceiling').toBe(false);
    });
});

describe('CORE-08: the consecutive-day streak', () => {
    const week = [
        day('2026-03-02', 28800), day('2026-03-03', 28800), day('2026-03-04', 28800),
        day('2026-03-05', 28800), day('2026-03-06', 28800)
    ];

    it('counts back from today when today has met the target', () => {
        expect(currentStreak(week, ld('2026-03-06'), EIGHT_HOUR_WEEK)).toBe(5);
    });

    it('counts back from yesterday when today has not, so a day in progress does not break it', () => {
        expect(currentStreak(week, ld('2026-03-07'), EIGHT_HOUR_WEEK),
            'a streak must not be reported as broken before the day is over').toBe(5);
        expect(currentStreak([...week, day('2026-03-07', 60)], ld('2026-03-07'), EIGHT_HOUR_WEEK)).toBe(5);
    });

    it('stops at the first day that missed the target, and at the first day with no sessions', () => {
        const missed = [...week.filter((d) => d.date !== '2026-03-04'), day('2026-03-04', 28799)];
        expect(currentStreak(missed, ld('2026-03-06'), EIGHT_HOUR_WEEK)).toBe(2);
        expect(currentStreak(week.filter((d) => d.date !== '2026-03-04'), ld('2026-03-06'), EIGHT_HOUR_WEEK)).toBe(2);
    });

    it('is zero when nothing has been tracked at all', () => {
        expect(currentStreak([], ld('2026-03-06'), EIGHT_HOUR_WEEK)).toBe(0);
        expect(currentStreak([day('2026-03-06', 60)], ld('2026-03-06'), EIGHT_HOUR_WEEK)).toBe(0);
    });

    it('steps over a weekend when the setting says to, and ends on one when it does not', () => {
        // Fri 2026-03-06 and Mon 2026-03-09 worked; Sat and Sun not.
        const workdays = [day('2026-03-05', 28800), day('2026-03-06', 28800), day('2026-03-09', 28800)];
        expect(currentStreak(workdays, ld('2026-03-09'), { dailyTargetSeconds: TARGET, excludeWeekends: true }),
            'Saturday and Sunday are stepped over, not counted').toBe(3);
        expect(currentStreak(workdays, ld('2026-03-09'), EIGHT_HOUR_WEEK),
            'with weekends counted, Sunday ends the streak').toBe(1);
    });

    it('terminates on an unbroken year instead of walking the calendar forever', () => {
        const everyDay: DayTotal[] = [];
        for (let offset = 0; offset < 500; offset++) {
            const date = new Date(2026, 2, 6);
            date.setDate(date.getDate() - offset);
            everyDay.push({ date: formatLocalDate(date), totalSeconds: TARGET });
        }
        const streak = currentStreak(everyDay, ld('2026-03-06'), { dailyTargetSeconds: TARGET, excludeWeekends: true });
        expect(streak, 'v1.2.1 skipped its own safety check on every weekend it stepped over')
            .toBeLessThanOrEqual(366);
        expect(streak).toBeGreaterThan(250);
    });
});

describe('CORE-08: Monday-to-Sunday week totals, as v1.2.1 sliced them', () => {
    // A transcription of database/db.js getThisWeekTotal: getDay(), then back to Monday, then six days on.
    function v121WeekRange(today: LocalDate, weeksAgo: number): [LocalDate, LocalDate] {
        const parts = today.split('-').map(Number);
        const anchor = new Date(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1);
        const dayOfWeek = anchor.getDay();
        const monday = new Date(
            anchor.getFullYear(), anchor.getMonth(),
            anchor.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1) - weeksAgo * 7
        );
        const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
        return [formatLocalDate(monday), formatLocalDate(sunday)];
    }

    it('starts its week on the same Monday v1.2.1 did, for every day of a year', () => {
        const disagreements: string[] = [];
        const walk = new Date(2026, 0, 1);
        for (let i = 0; i < 366; i++) {
            const today = formatLocalDate(walk);
            const [monday] = v121WeekRange(today, 0);
            if (startOfWeek(today) !== monday) disagreements.push(today + ': ' + startOfWeek(today) + ' != ' + monday);
            walk.setDate(walk.getDate() + 1);
        }
        expect(disagreements, 'the week boundary moved away from v1.2.1').toEqual([]);
    });

    it('sums Monday through Sunday for this week and the one before it', () => {
        const totals = [
            day('2026-02-22', 1000), // the Sunday that ends the week before last
            day('2026-02-23', 2000), // last Monday
            day('2026-03-01', 4000), // last Sunday
            day('2026-03-02', 8000), // this Monday
            day('2026-03-08', 16000) // this Sunday
        ];
        expect(weekTotals(totals, ld('2026-03-04'))).toEqual({ thisWeekSeconds: 24000, lastWeekSeconds: 6000 });
        expect(weekTotals(totals, ld('2026-03-02')), 'the answer is the same on any day of the week')
            .toEqual({ thisWeekSeconds: 24000, lastWeekSeconds: 6000 });
        expect(weekTotals(totals, ld('2026-03-08'))).toEqual({ thisWeekSeconds: 24000, lastWeekSeconds: 6000 });
    });

    it('counts a day beyond this Sunday in neither total, exactly as v1.2.1 BETWEEN did', () => {
        const totals = [day('2026-03-04', 3600), day('2026-03-09', 3600)];
        expect(weekTotals(totals, ld('2026-03-04')),
            'History still lists the session - weekBucketOf is total (D-02); only the totals stop at Sunday')
            .toEqual({ thisWeekSeconds: 3600, lastWeekSeconds: 0 });
    });

    it('totals to zero rather than null when a week has nothing in it', () => {
        expect(weekTotals([], ld('2026-03-04'))).toEqual({ thisWeekSeconds: 0, lastWeekSeconds: 0 });
    });
});

describe('B7: a day worked in several short blocks meets the target', () => {
    // The defect, transcribed from work-history.html:484 - the goal filter compared ONE session's duration.
    const v121GoalReached = (durations: readonly number[], target: number): boolean =>
        durations.some((duration) => duration >= target);

    it('says met where v1.2.1 said not met, and the streak counts the day', async () => {
        const dbPath = makeEmptyFixture();
        const probe = probeDatabase(dbPath);
        if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
        const connection = openDatabase(dbPath);
        try {
            await migrateDatabase(connection, {
                dbPath,
                dbClass: classify(probe.observed, LATEST),
                fromVersion: probe.observed.userVersion,
                backupDir: path.join(path.dirname(dbPath), 'backups')
            });
            const sessions = createSessionsRepository(createDbHandle(connection));

            // 2026-03-04: four two-hour blocks. 2026-03-03: one eight-hour block. 2026-03-02: three blocks.
            const seeded: [string, number][] = [
                ['2026-03-02', 9600], ['2026-03-02', 9600], ['2026-03-02', 9600],
                ['2026-03-03', 28800],
                ['2026-03-04', 7200], ['2026-03-04', 7200], ['2026-03-04', 7200], ['2026-03-04', 7200]
            ];
            for (const [date, durationSeconds] of seeded) {
                sessions.create({ name: 'Block', durationSeconds, date: ld(date), companyId: null, note: null });
            }

            const totals = sessions.dayTotals();
            const shortBlocks = sessions.listByDateRange(ld('2026-03-04'), ld('2026-03-04'))
                .map((session) => session.durationSeconds);

            expect(shortBlocks, 'the fixture must hold several short sessions, or the proof is vacuous')
                .toEqual([7200, 7200, 7200, 7200]);
            expect(v121GoalReached(shortBlocks, TARGET), 'v1.2.1 compared a single session against the target')
                .toBe(false);

            expect(totalForDay(totals, ld('2026-03-04')), 'the day total is what the target is compared against')
                .toBe(TARGET);
            expect(isGoalMet(totals, ld('2026-03-04'), TARGET), 'B7: the day met its target').toBe(true);
            expect(currentStreak(totals, ld('2026-03-04'), EIGHT_HOUR_WEEK),
                'B7: the streak reads the day total too, so all three days count').toBe(3);

            // Under the v1.2.1 rule only 2026-03-03 would have counted, and the streak would have been 1.
            const perSession = totals.filter((total) => total.date !== '2026-03-04' && total.date !== '2026-03-02');
            expect(currentStreak(perSession, ld('2026-03-04'), EIGHT_HOUR_WEEK),
                'the counterfactual: this is what a per-session decision produced').toBe(1);
        } finally {
            closeDatabase(connection);
        }
    });
});

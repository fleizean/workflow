// CORE-08: the streak and the day and week totals, as pure functions over day totals. No database handle, no clock
// and no Electron - the caller passes the day totals a repository read and the local day its clock reported.
//
// B7 is closed by the input type. v1.2.1 compared ONE session's duration against the daily target
// (work-history.html:484), so a day worked in several short blocks never counted. Nothing here can see a session.

import { addDays, diffDays, isoWeekday, startOfWeek } from '@shared/utils/date';
import { localDayOf } from '../ports';
import type { ClockPort } from '../ports';
import type { DayProgress, DayTotal, LocalDate, PomodoroCounts, Settings, Streak, WeekTotals } from '@shared/types';

export interface StreakSettings {
    readonly dailyTargetSeconds: number;
    readonly excludeWeekends: boolean;
}

// v1.2.1 walked back a day at a time and stopped at 365 (database/db.js calculateCurrentStreak).
const MAX_STREAK_DAYS = 365;

const byDate = (dayTotals: readonly DayTotal[]): Map<string, number> => {
    const totals = new Map<string, number>();
    for (const day of dayTotals) totals.set(day.date, (totals.get(day.date) ?? 0) + day.totalSeconds);
    return totals;
};

/** The whole day's tracked seconds; 0 for a day with nothing on it, never null (DATA-05). */
export function totalForDay(dayTotals: readonly DayTotal[], date: LocalDate): number {
    return byDate(dayTotals).get(date) ?? 0;
}

/** The day's total against the target - the decision v1.2.1 made per session instead of per day (B7). */
export function isGoalMet(dayTotals: readonly DayTotal[], date: LocalDate, dailyTargetSeconds: number): boolean {
    return totalForDay(dayTotals, date) >= dailyTargetSeconds;
}

const isWeekend = (date: LocalDate): boolean => isoWeekday(date) >= 6;

/**
 * Consecutive days that met the target, counting back from today - or from yesterday when today has not met it yet,
 * so a streak is not reported as broken before the day is over. With excludeWeekends a Saturday or Sunday is stepped
 * over rather than ending the count, exactly as v1.2.1 did.
 */
export function currentStreak(
    dayTotals: readonly DayTotal[],
    today: LocalDate,
    settings: StreakSettings
): number {
    const totals = byDate(dayTotals);
    const met = (date: LocalDate): boolean => (totals.get(date) ?? 0) >= settings.dailyTargetSeconds;

    let streak = 0;
    let checking = met(today) ? today : addDays(today, -1);

    while (diffDays(today, checking) <= MAX_STREAK_DAYS) {
        if (settings.excludeWeekends && isWeekend(checking)) {
            checking = addDays(checking, -1);
            continue;
        }
        if (!met(checking)) break;
        streak += 1;
        checking = addDays(checking, -1);
    }

    return streak;
}

/**
 * Monday-to-Sunday weeks, as v1.2.1 sliced them (database/db.js getThisWeekTotal / getLastWeekTotal). A day after
 * this Sunday belongs to neither total, which is the v1.2.1 behaviour and applies to the totals only - History still
 * shows the session, because weekBucketOf is total (D-02).
 */
export function weekTotals(dayTotals: readonly DayTotal[], today: LocalDate): WeekTotals {
    const monday = startOfWeek(today);
    const lastMonday = addDays(monday, -7);

    let thisWeekSeconds = 0;
    let lastWeekSeconds = 0;
    for (const day of dayTotals) {
        const offset = diffDays(day.date, monday);
        if (offset >= 0 && offset <= 6) {
            thisWeekSeconds += day.totalSeconds;
        } else if (diffDays(day.date, lastMonday) >= 0 && offset < 0) {
            lastWeekSeconds += day.totalSeconds;
        }
    }
    return { thisWeekSeconds, lastWeekSeconds };
}

/** Structural, so nothing here imports src/lib/db: the container passes the repositories themselves. */
export interface DayTotalsLedger {
    dayTotals(): DayTotal[];
    /** One day, read as one day. The streak and the week totals still need them all; a day's progress does not. */
    dayTotalFor(date: LocalDate): number;
}

export interface PomodoroDayLedger {
    countForDay(date: LocalDate): number;
}

export interface SettingsReader {
    get(): Settings;
}

export interface StatsServiceInput {
    readonly clock: ClockPort;
    readonly sessions: DayTotalsLedger;
    readonly pomodoro: PomodoroDayLedger;
    readonly settings: SettingsReader;
}

export interface StatsService {
    /** The whole day's tracked seconds, which is what the streak, the goal and Work History all measure (B7). */
    dayProgress(date: LocalDate): DayProgress;
    /** Today, as the clock's local day names it. */
    today(): DayProgress;
    streak(): Streak;
    weeks(): WeekTotals;
    pomodoroCounts(): PomodoroCounts;
}

const DAYS_IN_WEEK = 7;

export function createStatsService(input: StatsServiceInput): StatsService {
    const { clock, pomodoro, sessions, settings } = input;

    // WR-09: one date's own read. The goal decision asks this on the timer's tick, so aggregating every day the
    // user has ever recorded to read one of them made a late tick likelier the longer they had used the app.
    const progress = (date: LocalDate): DayProgress => {
        const { dailyTargetSeconds } = settings.get();
        const totalSeconds = sessions.dayTotalFor(date);
        return { date, totalSeconds, dailyTargetSeconds, goalMet: totalSeconds >= dailyTargetSeconds };
    };

    return {
        dayProgress: progress,
        today: () => progress(localDayOf(clock)),

        streak() {
            const today = localDayOf(clock);
            const current = settings.get();
            return {
                date: today,
                days: currentStreak(sessions.dayTotals(), today, {
                    dailyTargetSeconds: current.dailyTargetSeconds,
                    excludeWeekends: current.excludeWeekendsFromStreak
                })
            };
        },

        weeks: () => weekTotals(sessions.dayTotals(), localDayOf(clock)),

        // POMO-09: the week is the same Monday-to-Sunday slice the totals use, summed day by day from the ledger.
        pomodoroCounts() {
            const date = localDayOf(clock);
            const monday = startOfWeek(date);
            let thisWeekCount = 0;
            for (let offset = 0; offset < DAYS_IN_WEEK; offset++) {
                thisWeekCount += pomodoro.countForDay(addDays(monday, offset));
            }
            return { date, todayCount: pomodoro.countForDay(date), thisWeekCount };
        }
    };
}

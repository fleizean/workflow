// CORE-08: the streak and the day and week totals, as pure functions over day totals. No database handle, no clock
// and no Electron - the caller passes the day totals a repository read and the local day its clock reported.
//
// B7 is closed by the input type. v1.2.1 compared ONE session's duration against the daily target
// (work-history.html:484), so a day worked in several short blocks never counted. Nothing here can see a session.

import { addDays, diffDays, isoWeekday, startOfWeek } from '@shared/utils/date';
import type { DayTotal, LocalDate } from '@shared/types';

export interface StreakSettings {
    readonly dailyTargetSeconds: number;
    readonly excludeWeekends: boolean;
}

export interface WeekTotals {
    readonly thisWeekSeconds: number;
    readonly lastWeekSeconds: number;
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

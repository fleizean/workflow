/*
 * Everything Work History decides, as one pure function over the rows.
 *
 * It is a module rather than a hook because this is where three shipped defects lived and there is no jsdom here to
 * render a screen in:
 *
 *  - B8. legacy/renderer/shared.js:27 defined groupSessionsByWeek() and a repository-wide grep finds no caller.
 *    legacy/pages/work-history.html:558-570 blanked and hid the Last Week and Older sections on every render and
 *    :700 appended every card to thisWeekContainer, so the three headings were decoration over one list.
 *  - B6. The daily target was `const dailyTarget = 28800;` at :571, next to code that had just read the user's own
 *    target out of the database for the goal filter and then not used it for the badge.
 *  - B7. The goal filter compared a SINGLE session against the target (:465-471), so a day made of four two-hour
 *    sessions never counted as met, however long the day was. The badge on the card got this right; the filter
 *    beside it did not, and the two answers came from the same screen.
 *
 * The day totals are computed from every session, before any filter runs. Filtering by company would otherwise
 * change whether a day met its target, which is a different question from the one the badge asks.
 */

import { startOfWeek, addDays, weekBucketOf } from '@shared/utils/date';
import { formatShortDay } from '@renderer/lib/format';
import type { Company, LocalDate, WorkSession } from '@shared/types';

export type GoalFilter = 'all' | 'achieved' | 'not-achieved';
export type SortBy = 'date' | 'duration' | 'name';
export type SortOrder = 'asc' | 'desc';

/** v1.2.1's advanced-filter panel, as values. Empty strings are "unset", which is what its inputs produced. */
export interface HistoryFilters {
    readonly companyIds: readonly number[];
    readonly startDate: string;
    readonly endDate: string;
    readonly minHours: string;
    readonly maxHours: string;
    readonly goal: GoalFilter;
    readonly sortBy: SortBy;
    readonly sortOrder: SortOrder;
}

export const NO_FILTERS: HistoryFilters = {
    companyIds: [],
    startDate: '',
    endDate: '',
    minHours: '',
    maxHours: '',
    goal: 'all',
    sortBy: 'date',
    sortOrder: 'desc'
};

/** Whether the filter button should read as switched on. v1.2.1 computed this and then never showed it. */
export function filtersAreActive(filters: HistoryFilters): boolean {
    return filters.companyIds.length > 0 || filters.startDate !== '' || filters.endDate !== '' ||
        filters.minHours !== '' || filters.maxHours !== '' || filters.goal !== 'all';
}

/** One date and one company: the card v1.2.1 drew, and the sessions that fold out of it. */
export interface SessionGroup {
    readonly key: string;
    readonly date: LocalDate;
    readonly companyId: number | null;
    readonly companyName: string;
    readonly sessions: readonly WorkSession[];
    /** This card's own total. */
    readonly totalSeconds: number;
    /** The whole day's total, across every company and every session in it (B7). */
    readonly dayTotalSeconds: number;
    /*
     * WR-04: null when the daily target has not been read. A day cannot be judged against a target nobody has,
     * and substituting DEFAULT_SETTINGS for one that FAILED to read marked met days unmet with nothing on screen
     * to say the number was a stand-in.
     */
    readonly goalMet: boolean | null;
    readonly hasNotes: boolean;
    /** v1.2.1 drew a hairline where the date changed; true on every card but the first of its day. */
    readonly startsNewDay: boolean;
}

export interface HistoryBuckets {
    readonly thisWeek: readonly SessionGroup[];
    readonly lastWeek: readonly SessionGroup[];
    readonly older: readonly SessionGroup[];
}

export interface HistoryInput {
    readonly sessions: readonly WorkSession[];
    readonly companies: readonly Company[];
    readonly filters: HistoryFilters;
    /** null while the settings read has not answered - see SessionGroup.goalMet (WR-04). */
    readonly dailyTargetSeconds: number | null;
    readonly today: LocalDate;
}

/** Every local day's tracked total, over every session there is. The measure the goal badge and B7's filter use. */
export function dayTotals(sessions: readonly WorkSession[]): ReadonlyMap<string, number> {
    const totals = new Map<string, number>();
    for (const session of sessions) {
        totals.set(session.date, (totals.get(session.date) ?? 0) + session.durationSeconds);
    }
    return totals;
}

/** An empty string means the bound was left blank, which is not the same as a bound of zero. */
function boundSeconds(hours: string): number | undefined {
    if (hours.trim() === '') {
        return undefined;
    }
    const value = Number.parseFloat(hours);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value * 3600) : undefined;
}

function matches(session: WorkSession, input: HistoryInput, totals: ReadonlyMap<string, number>): boolean {
    const { filters, dailyTargetSeconds } = input;
    if (filters.companyIds.length > 0 &&
        (session.companyId === null || !filters.companyIds.includes(session.companyId))) {
        return false;
    }
    if (filters.startDate !== '' && session.date < filters.startDate) return false;
    if (filters.endDate !== '' && session.date > filters.endDate) return false;

    const min = boundSeconds(filters.minHours);
    const max = boundSeconds(filters.maxHours);
    if (min !== undefined && session.durationSeconds < min) return false;
    if (max !== undefined && session.durationSeconds > max) return false;

    if (filters.goal !== 'all' && dailyTargetSeconds !== null) {
        // B7: the DAY's total, not this session's. A day of four two-hour sessions is an eight-hour day.
        const met = (totals.get(session.date) ?? 0) >= dailyTargetSeconds;
        if (filters.goal === 'achieved' ? !met : met) return false;
    }
    return true;
}

/** Oldest first inside a card, so the fold-out reads down the day the way it was worked. */
const byRecordedOrder = (a: WorkSession, b: WorkSession): number =>
    a.createdAt === b.createdAt ? a.id - b.id : a.createdAt - b.createdAt;

function compareGroups(a: SessionGroup, b: SessionGroup, filters: HistoryFilters): number {
    const ascending = filters.sortBy === 'duration'
        ? a.totalSeconds - b.totalSeconds
        : filters.sortBy === 'name'
            ? a.companyName.localeCompare(b.companyName)
            : a.date.localeCompare(b.date);
    // A tie on duration or name still has to be stable and readable, so the date decides it.
    const settled = ascending === 0 ? a.date.localeCompare(b.date) : ascending;
    return filters.sortOrder === 'desc' ? -settled : settled;
}

export function buildHistory(input: HistoryInput): HistoryBuckets {
    const { sessions, companies, filters, dailyTargetSeconds, today } = input;
    const names = new Map(companies.map((company) => [company.id, company.name]));
    const totals = dayTotals(sessions);

    const grouped = new Map<string, WorkSession[]>();
    for (const session of sessions) {
        if (!matches(session, input, totals)) {
            continue;
        }
        // NT-01: '|null' rather than '|0'. SQLite AUTOINCREMENT never issues 0, so this needs a hand-inserted
        // row - but a null-company session and a companyId 0 session folding into one card labelled "No Company"
        // costs nothing to make impossible.
        const key = session.date + '|' + (session.companyId === null ? 'null' : String(session.companyId));
        const bucket = grouped.get(key);
        if (bucket === undefined) {
            grouped.set(key, [session]);
        } else {
            bucket.push(session);
        }
    }

    const groups: SessionGroup[] = [];
    for (const [key, rows] of grouped) {
        const first = rows[0];
        if (first === undefined) {
            continue;
        }
        const dayTotalSeconds = totals.get(first.date) ?? 0;
        groups.push({
            key,
            date: first.date,
            companyId: first.companyId,
            companyName: first.companyId === null
                ? 'No Company'
                : names.get(first.companyId) ?? 'No Company',
            sessions: [...rows].sort(byRecordedOrder),
            totalSeconds: rows.reduce((sum, row) => sum + row.durationSeconds, 0),
            dayTotalSeconds,
            goalMet: dailyTargetSeconds === null ? null : dayTotalSeconds >= dailyTargetSeconds,
            hasNotes: rows.some((row) => (row.note ?? '').trim() !== ''),
            startsNewDay: false
        });
    }
    groups.sort((a, b) => compareGroups(a, b, filters));

    // B8: three buckets, filled. A date after the current week stays in thisWeek, so nothing can vanish (D-02).
    const buckets: Record<'thisWeek' | 'lastWeek' | 'older', SessionGroup[]> =
        { thisWeek: [], lastWeek: [], older: [] };
    for (const group of groups) {
        buckets[weekBucketOf(group.date, today)].push(group);
    }
    return {
        thisWeek: withDaySeparators(buckets.thisWeek),
        lastWeek: withDaySeparators(buckets.lastWeek),
        older: withDaySeparators(buckets.older)
    };
}

function withDaySeparators(groups: readonly SessionGroup[]): SessionGroup[] {
    let previous: string | null = null;
    return groups.map((group) => {
        const startsNewDay = previous !== null && previous !== group.date;
        previous = group.date;
        return { ...group, startsNewDay };
    });
}

/** `Sep 14 - Sep 20`, from the Monday of the week `weeksAgo` before this one (legacy work-history.html:523-535). */
export function weekRangeLabel(today: LocalDate, weeksAgo: number): string {
    const start = addDays(startOfWeek(today), -7 * weeksAgo);
    return formatShortDay(start) + ' - ' + formatShortDay(addDays(start, 6));
}

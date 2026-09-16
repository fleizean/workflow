/*
 * Work History's three shipped defects, as failing-before / passing-after assertions over the module the screen is
 * built on. There is no jsdom in this project and no test renders a component, so this is where criterion 4's
 * first half is actually settled:
 *
 *  - B8: This Week / Last Week / Older are three buckets that get filled, across week boundaries.
 *  - B6: progress is measured against the target the caller passes, never a hard-coded 28800.
 *  - B7: the goal filter asks what the DAY totalled, not what one session did.
 *
 * What it does not settle is that the list renders in one DOM update. React commits one render; v1.2.1 wrote
 * `container.innerHTML += card` once per card, reparsing everything already there each time. buildHistory returning
 * the whole shape as one value is what makes the single commit possible, and is asserted below as a shape; the
 * commit itself is React's and is not observable from here.
 */

import { describe, expect, it } from 'vitest';
import {
    NO_FILTERS, buildHistory, dayTotals, filtersAreActive, weekRangeLabel
} from '@renderer/features/history/grouping';
import type { HistoryFilters } from '@renderer/features/history/grouping';
import { read } from './helpers/ts-imports';
import type { Company, LocalDate, WorkSession } from '@shared/types';

const day = (value: string): LocalDate => value as LocalDate;

/** 2026-09-16 is a Wednesday, so its week runs Mon 2026-09-14 .. Sun 2026-09-20. */
const TODAY = day('2026-09-16');
const TARGET = 28_800;

let nextId = 0;
const session = (date: string, durationSeconds: number, companyId: number | null = 1, note: string | null = null):
WorkSession => {
    nextId += 1;
    return {
        id: nextId,
        name: 'Session ' + String(nextId),
        durationSeconds,
        date: day(date),
        companyId,
        note,
        createdAt: 1_757_000_000_000 + nextId
    };
};

const COMPANIES: Company[] = [
    { id: 1, name: 'Acme', noteRequired: false, createdAt: 1 },
    { id: 2, name: 'Beta', noteRequired: true, createdAt: 2 }
];

const build = (sessions: readonly WorkSession[], filters: HistoryFilters = NO_FILTERS): ReturnType<typeof buildHistory> =>
    buildHistory({ sessions, companies: COMPANIES, filters, dailyTargetSeconds: TARGET, today: TODAY });

describe('B8: the three sections are three sections', () => {
    it('puts each session in the bucket its date falls in', () => {
        const buckets = build([
            session('2026-09-16', 3600),  // this week (Wednesday)
            session('2026-09-14', 3600),  // this week (Monday, the boundary itself)
            session('2026-09-13', 3600),  // last week (Sunday, the day before the boundary)
            session('2026-09-07', 3600),  // last week (its Monday)
            session('2026-09-06', 3600)   // older (the day before that)
        ]);
        expect(buckets.thisWeek.map((g) => g.date)).toEqual(['2026-09-16', '2026-09-14']);
        expect(buckets.lastWeek.map((g) => g.date)).toEqual(['2026-09-13', '2026-09-07']);
        expect(buckets.older.map((g) => g.date)).toEqual(['2026-09-06']);
    });

    it('loses nothing: every session lands in exactly one bucket', () => {
        const sessions = [
            session('2026-09-20', 60), session('2026-09-14', 60), session('2026-09-13', 60),
            session('2026-09-07', 60), session('2026-09-06', 60), session('2020-01-01', 60)
        ];
        const buckets = build(sessions);
        const placed = [...buckets.thisWeek, ...buckets.lastWeek, ...buckets.older]
            .flatMap((group) => group.sessions.map((row) => row.id));
        expect([...placed].sort((a, b) => a - b)).toEqual(sessions.map((row) => row.id).sort((a, b) => a - b));
    });

    /*
     * D-02. A session dated after today - which is what a date picker set forward produces - must not fall out of
     * every bucket and off the screen. It stays in This Week, because the alternative is losing tracked time from
     * view entirely.
     */
    it('keeps a session dated after today on the screen', () => {
        const buckets = build([session('2027-01-01', 3600)]);
        expect(buckets.thisWeek).toHaveLength(1);
        expect(buckets.older).toHaveLength(0);
    });

    it('names the week ranges the two headings carry', () => {
        expect(weekRangeLabel(TODAY, 0)).toBe('Sep 14 - Sep 20');
        expect(weekRangeLabel(TODAY, 1)).toBe('Sep 7 - Sep 13');
    });
});

describe('B6: the target is the caller\'s, never 28800', () => {
    it('marks a six-hour day met under a six-hour target and unmet under eight', () => {
        const rows = [session('2026-09-16', 21_600)];
        const under28800 = buildHistory({
            sessions: rows, companies: COMPANIES, filters: NO_FILTERS, dailyTargetSeconds: 21_600, today: TODAY
        });
        expect(under28800.thisWeek[0]?.goalMet, 'a six-hour day against a six-hour target is met').toBe(true);
        expect(build(rows).thisWeek[0]?.goalMet, 'the same day against eight hours is not').toBe(false);
    });

    it('reads a target the user raised above v1.2.1\'s constant', () => {
        const rows = [session('2026-09-16', 28_800)];
        const raised = buildHistory({
            sessions: rows, companies: COMPANIES, filters: NO_FILTERS, dailyTargetSeconds: 36_000, today: TODAY
        });
        expect(raised.thisWeek[0]?.goalMet, 'eight hours against a ten-hour target is not a met day').toBe(false);
    });
});

describe('B7: the goal is a day\'s total, not a session\'s', () => {
    const FOUR_SHORT_SESSIONS = [
        session('2026-09-16', 7_200), session('2026-09-16', 7_200),
        session('2026-09-16', 7_200), session('2026-09-16', 7_200)
    ];

    it('counts a day made of four two-hour sessions as an eight-hour day', () => {
        const [group] = build(FOUR_SHORT_SESSIONS).thisWeek;
        expect(group?.dayTotalSeconds).toBe(28_800);
        expect(group?.goalMet, 'the badge already got this right in v1.2.1').toBe(true);
    });

    it('keeps that day when the filter asks for achieved days', () => {
        const achieved = build(FOUR_SHORT_SESSIONS, { ...NO_FILTERS, goal: 'achieved' });
        expect(
            achieved.thisWeek.flatMap((group) => group.sessions),
            'v1.2.1 compared each session against the whole target, so this day disappeared from its own filter'
        ).toHaveLength(4);
    });

    it('drops that day when the filter asks for days not yet met', () => {
        const notYet = build(FOUR_SHORT_SESSIONS, { ...NO_FILTERS, goal: 'not-achieved' });
        expect(notYet.thisWeek).toEqual([]);
    });

    it('still separates a met day from an unmet one', () => {
        const rows = [...FOUR_SHORT_SESSIONS, session('2026-09-15', 3_600)];
        const achieved = build(rows, { ...NO_FILTERS, goal: 'achieved' });
        const notYet = build(rows, { ...NO_FILTERS, goal: 'not-achieved' });
        expect(achieved.thisWeek.map((group) => group.date)).toEqual(['2026-09-16']);
        expect(notYet.thisWeek.map((group) => group.date)).toEqual(['2026-09-15']);
    });

    /*
     * The day total is taken before any filter runs. Otherwise narrowing to one company would change whether the
     * day met its target, and the badge would answer a different question from the one it asks.
     */
    it('measures the day against everything worked in it, not against what the filter left', () => {
        const rows = [session('2026-09-16', 14_400, 1), session('2026-09-16', 14_400, 2)];
        const oneCompany = build(rows, { ...NO_FILTERS, companyIds: [1] });
        expect(oneCompany.thisWeek).toHaveLength(1);
        expect(oneCompany.thisWeek[0]?.totalSeconds, 'the card shows what the filter left').toBe(14_400);
        expect(oneCompany.thisWeek[0]?.dayTotalSeconds, 'the day is still an eight-hour day').toBe(28_800);
        expect(oneCompany.thisWeek[0]?.goalMet).toBe(true);
    });
});

describe('grouping: one card per date and company, as v1.2.1 drew it', () => {
    it('folds a day\'s sessions for one company into one card', () => {
        const buckets = build([
            session('2026-09-16', 3_600, 1), session('2026-09-16', 1_800, 1), session('2026-09-16', 3_600, 2)
        ]);
        expect(buckets.thisWeek).toHaveLength(2);
        const acme = buckets.thisWeek.find((group) => group.companyName === 'Acme');
        expect(acme?.sessions).toHaveLength(2);
        expect(acme?.totalSeconds).toBe(5_400);
    });

    it('calls a session attributed to nothing "No Company"', () => {
        const [group] = build([session('2026-09-16', 60, null)]).thisWeek;
        expect(group?.companyName).toBe('No Company');
        expect(group?.companyId).toBeNull();
    });

    it('flags a card whose sessions carry a note, and ignores a note of spaces', () => {
        const withNote = build([session('2026-09-16', 60, 1, 'wrote the thing')]).thisWeek[0];
        const withBlank = build([session('2026-09-15', 60, 1, '   ')]).thisWeek[0];
        expect(withNote?.hasNotes).toBe(true);
        expect(withBlank?.hasNotes).toBe(false);
    });

    it('marks the first card of each new day, which is where the hairline went', () => {
        const buckets = build([
            session('2026-09-16', 60, 1), session('2026-09-16', 60, 2), session('2026-09-15', 60, 1)
        ]);
        expect(buckets.thisWeek.map((group) => group.startsNewDay)).toEqual([false, false, true]);
    });

    it('orders a card\'s sessions oldest first', () => {
        const first = session('2026-09-16', 60, 1);
        const second = session('2026-09-16', 60, 1);
        const [group] = build([second, first]).thisWeek;
        expect(group?.sessions.map((row) => row.id)).toEqual([first.id, second.id]);
    });

    it('returns the whole screen as one value, so one render can draw it', () => {
        const buckets = build([session('2026-09-16', 60), session('2026-09-07', 60), session('2020-01-01', 60)]);
        expect(Object.keys(buckets).sort()).toEqual(['lastWeek', 'older', 'thisWeek']);
        expect(buckets.thisWeek).toHaveLength(1);
        expect(buckets.lastWeek).toHaveLength(1);
        expect(buckets.older).toHaveLength(1);
    });
});

describe('the filter panel\'s other controls', () => {
    const ROWS = [
        session('2026-09-16', 3_600, 1), session('2026-09-15', 18_000, 2), session('2026-09-14', 60, 1)
    ];

    it('narrows to the chosen companies', () => {
        const only = build(ROWS, { ...NO_FILTERS, companyIds: [2] });
        expect(only.thisWeek.map((group) => group.companyName)).toEqual(['Beta']);
    });

    it('bounds by date, inclusive at both ends', () => {
        const between = build(ROWS, { ...NO_FILTERS, startDate: '2026-09-15', endDate: '2026-09-16' });
        expect(between.thisWeek.map((group) => group.date)).toEqual(['2026-09-16', '2026-09-15']);
    });

    it('bounds by a session\'s own duration in hours', () => {
        const atLeastOne = build(ROWS, { ...NO_FILTERS, minHours: '1' });
        expect(atLeastOne.thisWeek.map((group) => group.date)).toEqual(['2026-09-16', '2026-09-15']);
        const atMostTwo = build(ROWS, { ...NO_FILTERS, maxHours: '2' });
        expect(atMostTwo.thisWeek.map((group) => group.date)).toEqual(['2026-09-16', '2026-09-14']);
    });

    it('treats a blank bound as no bound rather than as zero', () => {
        expect(build(ROWS, { ...NO_FILTERS, minHours: '', maxHours: '  ' }).thisWeek).toHaveLength(3);
    });

    it('sorts by date, by duration and by company name, both ways', () => {
        const dates = (filters: HistoryFilters): string[] => build(ROWS, filters).thisWeek.map((g) => g.date);
        expect(dates({ ...NO_FILTERS, sortBy: 'date', sortOrder: 'desc' }))
            .toEqual(['2026-09-16', '2026-09-15', '2026-09-14']);
        expect(dates({ ...NO_FILTERS, sortBy: 'date', sortOrder: 'asc' }))
            .toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
        expect(dates({ ...NO_FILTERS, sortBy: 'duration', sortOrder: 'desc' }))
            .toEqual(['2026-09-15', '2026-09-16', '2026-09-14']);
        expect(build(ROWS, { ...NO_FILTERS, sortBy: 'name', sortOrder: 'asc' }).thisWeek
            .map((group) => group.companyName)).toEqual(['Acme', 'Acme', 'Beta']);
    });

    it('knows when it is switched on', () => {
        expect(filtersAreActive(NO_FILTERS)).toBe(false);
        expect(filtersAreActive({ ...NO_FILTERS, sortBy: 'name' }), 'a sort order is not a filter').toBe(false);
        expect(filtersAreActive({ ...NO_FILTERS, companyIds: [1] })).toBe(true);
        expect(filtersAreActive({ ...NO_FILTERS, goal: 'achieved' })).toBe(true);
        expect(filtersAreActive({ ...NO_FILTERS, minHours: '2' })).toBe(true);
    });
});

describe('dayTotals', () => {
    it('adds every session in a day together, whatever it was attributed to', () => {
        const totals = dayTotals([
            session('2026-09-16', 3_600, 1), session('2026-09-16', 3_600, 2), session('2026-09-16', 3_600, null),
            session('2026-09-15', 60, 1)
        ]);
        expect(totals.get('2026-09-16')).toBe(10_800);
        expect(totals.get('2026-09-15')).toBe(60);
        expect(totals.get('2026-09-14')).toBeUndefined();
    });
});

/*
 * 08-REVIEW-SCREENS WR-04. `settings.data?.dailyTargetSeconds ?? DEFAULT_SETTINGS.dailyTargetSeconds` is honest
 * while the read is in flight and dishonest after it fails - and `retry: false` means one transient failure is
 * enough. Every Goal pill and every achieved/not-achieved filter then measured against 28800, B6's exact constant,
 * for as long as the user stayed on the route, with nothing on screen to say the number was a stand-in. A user
 * with a six-hour target saw days marked unmet that they met.
 *
 * A target nobody has read is not eight hours. It is nothing, and a day cannot be judged against nothing.
 */
describe('WR-04: an unread target is not a default target', () => {
    const rows = [session('2026-09-16', 6 * 3600), session('2026-09-15', 9 * 3600)];
    const withTarget = (target: number | null, filters: HistoryFilters = NO_FILTERS): ReturnType<typeof buildHistory> =>
        buildHistory({ sessions: rows, companies: COMPANIES, filters, dailyTargetSeconds: target, today: TODAY });

    it('answers "not known" rather than "not met" for every card', () => {
        for (const group of withTarget(null).thisWeek) {
            expect(group.goalMet, 'a day was judged against a target nobody read').toBeNull();
        }
    });

    it('judges every card once the target has been read', () => {
        expect(withTarget(6 * 3600).thisWeek.map((group) => group.goalMet)).toEqual([true, true]);
    });

    it('does not filter by a goal it cannot measure, rather than filtering by 28800', () => {
        const achieved = { ...NO_FILTERS, goal: 'achieved' as const };
        expect(withTarget(null, achieved).thisWeek).toHaveLength(2);
        // The control: with a real target the same filter still narrows.
        expect(withTarget(8 * 3600, achieved).thisWeek).toHaveLength(1);
    });

    it('is what the screen passes, and it says so when the read failed', () => {
        const page = read('src/renderer/src/features/history/HistoryPage.tsx');
        expect(page, 'a failed settings read still reported 28800 as the target')
            .not.toContain('settings.data?.dailyTargetSeconds ?? DEFAULT_SETTINGS.dailyTargetSeconds');
        expect(page).toContain('settings.isSuccess');
        expect(page).toContain('settings.isError');
    });
});

/* NT-01: a company with id 0 and no company at all are two different cards. */
describe('NT-01: the group key tells "no company" from company zero', () => {
    it('keeps them apart on the same day', () => {
        const noCompany = session('2026-09-16', 3600, null);
        const companyZero = session('2026-09-16', 3600, 0);
        const buckets = buildHistory({
            sessions: [noCompany, companyZero], companies: COMPANIES, filters: NO_FILTERS,
            dailyTargetSeconds: TARGET, today: TODAY
        });
        expect(buckets.thisWeek, 'both folded into one card labelled "No Company"').toHaveLength(2);
        expect(new Set(buckets.thisWeek.map((group) => group.key)).size).toBe(2);
    });
});

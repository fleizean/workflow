// Every query key in one place, so an invalidation and the query it means to refresh cannot drift apart.

import type { DataDomain } from '@shared/types';

/*
 * SPA-07: the first segment of every key is the domain main announces a change in, so invalidating a whole domain
 * is invalidating a key prefix. tests/renderer-data-path.test.ts holds that true - a key whose first segment is not
 * a domain is a cache nothing in main could ever refresh.
 */
export const queryKeys = {
    companies: ['companies'] as const,
    sessions: ['sessions'] as const,
    settings: ['settings'] as const,
    timerSnapshot: ['timer', 'snapshot'] as const,
    // HIST-01's summary card. 'stats' is a domain main announces, so a saved session refreshes this with the list.
    weekTotals: ['stats', 'weekTotals'] as const,
    // TIMER-09. Keyed under 'stats' for the same reason: a saved session can carry the day and move the streak.
    streak: ['stats', 'streak'] as const,
    // POMO-08/POMO-09. The cycle is its own domain, and settings:update announces that domain too (WR-04), so a
    // duration changed on Settings refreshes what the running interval is measured against.
    pomodoroSnapshot: ['pomodoro', 'snapshot'] as const,
    pomodoroCounts: ['pomodoro', 'counts'] as const
};

/** What a `data:changed` domain invalidates: the prefix every key in that domain starts with. */
export const queryKeyForDomain = (domain: DataDomain): readonly [DataDomain] => [domain];

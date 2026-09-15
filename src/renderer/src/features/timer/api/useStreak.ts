// TIMER-09: the streak card's number, computed by stats.service.ts over whole-day totals (B7) rather than by the
// screen. v1.2.1 asked the same question and then let a click handler overwrite the answer with 6, 15 or 25.

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { Streak } from '@shared/types';

export const streakQuery = {
    queryKey: queryKeys.streak,
    queryFn: (): Promise<Streak> => invoke('stats:streak')
};

export function useStreak(): UseQueryResult<Streak> {
    return useQuery(streakQuery);
}

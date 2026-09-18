// HIST-01's summary card. Main adds the week up (stats.service.ts); the renderer does no date arithmetic over rows.

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { WeekTotals } from '@shared/types';

export const weekTotalsQuery = {
    queryKey: queryKeys.weekTotals,
    queryFn: (): Promise<WeekTotals> => invoke('stats:weekTotals')
};

export function useWeekTotals(): UseQueryResult<WeekTotals> {
    return useQuery(weekTotalsQuery);
}

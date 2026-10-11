// PANEL-03: the day's recorded total and the target it is measured against, for the day main's clock calls today.
// One day read as one day (WR-09); the whole-history aggregate the streak needs is not what a bar costs.

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { DayProgress } from '@shared/types';

export const todayProgressQuery = {
    queryKey: queryKeys.todayProgress,
    queryFn: (): Promise<DayProgress> => invoke('stats:today')
};

export function useTodayProgress(): UseQueryResult<DayProgress> {
    return useQuery(todayProgressQuery);
}

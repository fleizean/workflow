/*
 * The session list, read from this feature rather than borrowed from features/history.
 *
 * Companies needs a count per company: v1.2.1's row showed one, and COMP-05's delete warning has to name the
 * sessions it is about to take with it. History needs company names in return, so importing one feature's surface
 * from the other would make the two mutually dependent - and an index.ts carries its feature's page with it, so the
 * cycle would be between two screens, not between two hooks.
 *
 * The key is queryKeys.sessions either way, so this is the same cache entry and the same fetch that
 * features/history reads. What is duplicated is one line naming the channel, not the data.
 */

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { WorkSession } from '@shared/types';

export const companySessionsQuery = {
    queryKey: queryKeys.sessions,
    queryFn: (): Promise<WorkSession[]> => invoke('sessions:list')
};

export function useCompanySessions(): UseQueryResult<WorkSession[]> {
    return useQuery(companySessionsQuery);
}

/*
 * The session list, read from this feature rather than borrowed from features/history.
 *
 * Companies needs a count per company; History needs company names in return, so importing one feature's surface
 * from the other would make the two mutually dependent - and an index.ts carries its feature's page with it, so
 * the cycle would be between two screens. The key is queryKeys.sessions either way, so this is the same cache
 * entry and the same fetch: what is duplicated is one line naming the channel, not the data.
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

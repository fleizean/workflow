import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { WorkSession } from '@shared/types';

export function useSessions(): UseQueryResult<WorkSession[]> {
    return useQuery({
        queryKey: queryKeys.sessions,
        queryFn: () => invoke('sessions:list')
    });
}

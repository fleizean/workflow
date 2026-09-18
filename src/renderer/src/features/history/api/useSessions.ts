import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { WorkSession } from '@shared/types';

/*
 * Exported as data, and the hook is one line over it (SPA-05). There is no jsdom in this project, so a test cannot
 * render the hook - but it can run exactly this object through a real QueryClient against a failing bridge and
 * watch the query end in an error state. A queryFn written inline would leave that claim to a code reviewer.
 */
export const sessionsQuery = {
    queryKey: queryKeys.sessions,
    queryFn: (): Promise<WorkSession[]> => invoke('sessions:list')
};

export function useSessions(): UseQueryResult<WorkSession[]> {
    return useQuery(sessionsQuery);
}

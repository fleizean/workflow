/*
 * The session list, read by Home for the selected day's logged total and - in slice D - for the pomodoro intervals
 * that are on disk and still unattributed.
 *
 * It names the same channel and the same queryKeys.sessions as History and Companies do, so all three screens read
 * ONE cache entry and one fetch. The alternative, importing features/history's hook, would make two screens
 * mutually dependent through an index.ts that carries a page with it (the argument is in 08-A-SUMMARY.md).
 * tests/renderer-data-path.test.ts holds the three keys equal, because that equality is the whole justification.
 */

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { WorkSession } from '@shared/types';

export const timerSessionsQuery = {
    queryKey: queryKeys.sessions,
    queryFn: (): Promise<WorkSession[]> => invoke('sessions:list')
};

export function useTimerSessions(): UseQueryResult<WorkSession[]> {
    return useQuery(timerSessionsQuery);
}

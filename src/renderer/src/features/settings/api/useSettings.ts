import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { Settings } from '@shared/types';

export const settingsQuery = {
    queryKey: queryKeys.settings,
    queryFn: (): Promise<Settings> => invoke('settings:get')
};

export function useSettings(): UseQueryResult<Settings> {
    return useQuery(settingsQuery);
}

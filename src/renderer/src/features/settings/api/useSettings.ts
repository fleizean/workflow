import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { Settings } from '@shared/types';

export function useSettings(): UseQueryResult<Settings> {
    return useQuery({
        queryKey: queryKeys.settings,
        queryFn: () => invoke('settings:get')
    });
}

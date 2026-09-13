import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { Company } from '@shared/types';

export const companiesQuery = {
    queryKey: queryKeys.companies,
    queryFn: (): Promise<Company[]> => invoke('companies:list')
};

export function useCompanies(): UseQueryResult<Company[]> {
    return useQuery(companiesQuery);
}

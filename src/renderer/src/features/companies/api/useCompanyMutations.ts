/*
 * COMP-01..05's three writes. None invalidates anything: main announces what a successful call changed on
 * `data:changed` and DataSyncProvider invalidates on that (SPA-07), so a mutation that also invalidated would be
 * the second, quieter refresh path the contract rules out. Nor does any raise its own error toast - QueryProvider's
 * MutationCache onError raises one for every failed write in the app.
 */

import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import type { Company } from '@shared/types';

export interface CompanyValues {
    readonly name: string;
    readonly noteRequired: boolean;
}

export function useCreateCompany(): UseMutationResult<Company, Error, CompanyValues> {
    return useMutation({
        mutationFn: (values: CompanyValues): Promise<Company> => invoke('companies:create', values)
    });
}

export function useUpdateCompany(): UseMutationResult<Company, Error, CompanyValues & { readonly id: number }> {
    return useMutation({
        mutationFn: (values: CompanyValues & { readonly id: number }): Promise<Company> =>
            invoke('companies:update', values)
    });
}

/** Answers with the number of sessions the cascade actually took, which is what the confirmation quoted (COMP-05). */
export function useDeleteCompany(): UseMutationResult<{ deletedSessionCount: number }, Error, number> {
    return useMutation({
        mutationFn: (id: number): Promise<{ deletedSessionCount: number }> => invoke('companies:delete', { id })
    });
}

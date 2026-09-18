/*
 * HIST-05/06: adding, editing and deleting a past session. None invalidates anything and none raises its own error
 * toast: main announces sessions and stats on a successful write and DataSyncProvider invalidates on that (SPA-07),
 * and QueryProvider's MutationCache raises one error toast for every failed write.
 *
 * The bounds are the contract's - WR-07 refuses a duration above a day and a name of nothing at the boundary.
 */

import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import type { LocalDate, WorkSession } from '@shared/types';

export interface SessionValues {
    readonly name: string;
    readonly durationSeconds: number;
    readonly date: LocalDate;
    readonly companyId: number | null;
    readonly note: string | null;
}

export function useCreateSession(): UseMutationResult<WorkSession, Error, SessionValues> {
    return useMutation({
        mutationFn: (values: SessionValues): Promise<WorkSession> => invoke('sessions:create', values)
    });
}

export function useUpdateSession(): UseMutationResult<WorkSession, Error, SessionValues & { readonly id: number }> {
    return useMutation({
        mutationFn: (values: SessionValues & { readonly id: number }): Promise<WorkSession> =>
            invoke('sessions:update', values)
    });
}

export function useDeleteSession(): UseMutationResult<void, Error, number> {
    return useMutation({
        mutationFn: (id: number): Promise<void> => invoke('sessions:delete', { id })
    });
}

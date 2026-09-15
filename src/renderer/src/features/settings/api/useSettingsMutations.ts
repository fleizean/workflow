/*
 * SET-01..05's two writes. Neither invalidates anything and neither raises its own error toast: main announces the
 * domains a successful call changed and DataSyncProvider invalidates on that (SPA-07), and QueryProvider's
 * MutationCache raises one error toast for every failed write in the app - including the service's own refusal
 * message, which is what the user sees if a value gets past the screen's own review.
 */

import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import type { Settings } from '@shared/types';
import type { SettingsPatch } from '../settings-view';

/** The keys the form owns. pomodoroEnabled is not one of them - useTimerMode.ts writes that one, with the mode. */
export function useUpdateSettings(): UseMutationResult<Settings, Error, SettingsPatch> {
    return useMutation({
        mutationFn: (patch: SettingsPatch): Promise<Settings> => invoke('settings:update', patch)
    });
}

/** The literal the channel demands: irreversible, so the caller spells it out rather than passing a flag (WR-05). */
const DELETE_ALL_CONFIRMATION = 'DELETE_ALL_SESSIONS';

export interface DeleteAllResult {
    readonly deletedSessionCount: number;
}

export function useDeleteAllSessions(): UseMutationResult<DeleteAllResult, Error, void> {
    return useMutation({
        mutationFn: (): Promise<DeleteAllResult> =>
            invoke('sessions:deleteAll', { confirm: DELETE_ALL_CONFIRMATION })
    });
}

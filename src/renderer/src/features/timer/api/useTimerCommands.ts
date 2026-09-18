/*
 * TIMER-01/02/06: the four things the Home screen can ask of the clock, and the one composition it cannot do for
 * itself. None of them invalidates anything - main announces what a successful call changed on `data:changed` and
 * DataSyncProvider invalidates on that (SPA-07) - and none raises its own error toast.
 *
 * `timer:stopAndSave` is deliberately the only way this screen records work. `sessions:create` followed by
 * `timer:reset` is two invokes and two invokes cannot be atomic: killed between them, the first order leaves the
 * session on disk with the seconds still counted and G3/G4 offers the same work again, and the second zeroes the
 * accumulator with nothing written (WR-06). Nothing here may reintroduce the two-call shape.
 *
 * The mode toggle is NOT here: Settings toggles the same mode and the pair of writes must stay a pair, so it lives
 * in features/settings/api/useTimerMode.ts.
 */

import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import type { LocalDate, TimerSnapshot, WorkSession } from '@shared/types';

export interface StopAndSaveValues {
    readonly name: string;
    readonly durationSeconds: number;
    readonly date: LocalDate;
    readonly companyId: number | null;
    readonly note: string | null;
}

export function useStartTimer(): UseMutationResult<TimerSnapshot, Error, void> {
    return useMutation({ mutationFn: (): Promise<TimerSnapshot> => invoke('timer:start') });
}

export function usePauseTimer(): UseMutationResult<TimerSnapshot, Error, void> {
    return useMutation({ mutationFn: (): Promise<TimerSnapshot> => invoke('timer:pause') });
}

/** The one path that discards counted time. Every caller of it asks first, and says how much (see TimerPage). */
export function useResetTimer(): UseMutationResult<TimerSnapshot, Error, void> {
    return useMutation({ mutationFn: (): Promise<TimerSnapshot> => invoke('timer:reset') });
}

/** The insert and the discard, as main's one transaction. The session that comes back is the one written. */
export function useStopAndSave(): UseMutationResult<WorkSession, Error, StopAndSaveValues> {
    return useMutation({
        mutationFn: (values: StopAndSaveValues): Promise<WorkSession> => invoke('timer:stopAndSave', values)
    });
}

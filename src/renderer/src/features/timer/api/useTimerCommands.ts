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
 *
 * What each one ANSWERS with, though, is the authoritative snapshot, and all three used to throw it away. Writing it
 * into the store is the renderer's own way back: it owns no clock and refetches nothing on focus, so when
 * main-originated events stop arriving - a renderer the OS discarded, a sleep nothing noticed - the screen is frozen
 * until something tells it otherwise. One press now does, instead of two presses or a relaunch.
 *
 * The options objects are exported so a test can run the real ones; useMutation is given exactly these.
 */

import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { setTimerSnapshot } from '../state/timer.store';
import type { LocalDate, TimerSnapshot, WorkSession } from '@shared/types';

export interface StopAndSaveValues {
    readonly name: string;
    readonly durationSeconds: number;
    readonly date: LocalDate;
    readonly companyId: number | null;
    readonly note: string | null;
}

const adoptSnapshot = (snapshot: TimerSnapshot): void => { setTimerSnapshot(snapshot); };

export const startTimerMutation = {
    mutationFn: (): Promise<TimerSnapshot> => invoke('timer:start'),
    onSuccess: adoptSnapshot
};

export const pauseTimerMutation = {
    mutationFn: (): Promise<TimerSnapshot> => invoke('timer:pause'),
    onSuccess: adoptSnapshot
};

export const resetTimerMutation = {
    mutationFn: (): Promise<TimerSnapshot> => invoke('timer:reset'),
    onSuccess: adoptSnapshot
};

export function useStartTimer(): UseMutationResult<TimerSnapshot, Error, void> {
    return useMutation(startTimerMutation);
}

export function usePauseTimer(): UseMutationResult<TimerSnapshot, Error, void> {
    return useMutation(pauseTimerMutation);
}

/** The one path that discards counted time. Every caller of it asks first, and says how much (see TimerPage). */
export function useResetTimer(): UseMutationResult<TimerSnapshot, Error, void> {
    return useMutation(resetTimerMutation);
}

/** The insert and the discard, as main's one transaction. The session that comes back is the one written. */
export function useStopAndSave(): UseMutationResult<WorkSession, Error, StopAndSaveValues> {
    return useMutation({
        mutationFn: (values: StopAndSaveValues): Promise<WorkSession> => invoke('timer:stopAndSave', values)
    });
}

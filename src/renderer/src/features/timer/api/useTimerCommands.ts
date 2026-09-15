/*
 * TIMER-01/02/06: the four things the Home screen can ask of the clock, and the one composition it cannot do for
 * itself.
 *
 * None of them invalidates anything - main announces what a successful call changed on `data:changed` and
 * DataSyncProvider invalidates on that (SPA-07) - and none raises its own error toast, because QueryProvider's
 * MutationCache raises one for every failed write in the app.
 *
 * `timer:stopAndSave` is deliberately the only way this screen records work. Phase 5 added the channel because
 * `sessions:create` followed by `timer:reset` is two invokes and two invokes cannot be atomic: killed between them,
 * the first order leaves the session on disk with the seconds still counted and G3/G4 offers the same work again,
 * and the second zeroes the accumulator with nothing written. Both are the Core Value, so the pairing lives below
 * IPC in one transaction (WR-06). Nothing here may reintroduce the two-call shape.
 */

import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import type { LocalDate, Settings, TimerMode, TimerSnapshot, WorkSession } from '@shared/types';

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

/*
 * CORE-14/CB-1: a mode change touches the mode and nothing else. v1.2.1's toggle called reset() on both branches
 * (legacy/renderer/timer.js:115 and :126), so tapping it threw away every unsaved second, and then threw a
 * TypeError before it could even repaint.
 *
 * Two writes, because two things mean it: timer.state.mode is what the clock runs in and survives a restart, and
 * settings.pomodoroEnabled is the preference the Settings screen shows. Keeping them in step here is what stops
 * Settings reporting "off" while Home counts down a pomodoro. Neither write touches the accumulator, so a failure
 * of the second costs a checkbox and never a second of counted time.
 */
export function useSetTimerMode(): UseMutationResult<Settings, Error, TimerMode> {
    return useMutation({
        mutationFn: async (mode: TimerMode): Promise<Settings> => {
            await invoke('timer:setMode', { mode });
            return invoke('settings:update', { pomodoroEnabled: mode === 'pomodoro' });
        }
    });
}

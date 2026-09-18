/*
 * The cycle's reads and writes. Every one is a request to main, which owns the clock, the state machine and the one
 * transaction that records a completed interval (POMO-01). None invalidates anything - main announces the domains a
 * successful call changed and DataSyncProvider invalidates on that (SPA-07) - and none raises its own error toast.
 *
 * There is deliberately no "record a pomodoro" call here, and there must not be one: the session row and the
 * pomodoro_sessions row are written together by the container before anything on this side is told, so a renderer
 * that also wrote one would record the same work twice.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import { usePomodoroStore } from '../state/pomodoro.store';
import type { LocalDate, PomodoroCounts, PomodoroSnapshot, WorkSession } from '@shared/types';

export const pomodoroSnapshotQuery = {
    queryKey: queryKeys.pomodoroSnapshot,
    queryFn: (): Promise<PomodoroSnapshot> => invoke('pomodoro:getSnapshot')
};

export const pomodoroCountsQuery = {
    queryKey: queryKeys.pomodoroCounts,
    queryFn: (): Promise<PomodoroCounts> => invoke('pomodoro:counts')
};

/**
 * The opening value, and every value after it arrives as a tick. It is read again whenever the pomodoro domain is
 * invalidated - which `settings:update` announces (WR-04), so a duration changed on Settings reaches a cycle that
 * is paused or idle and therefore pushing no ticks (POMO-06).
 */
export function usePomodoroSnapshot(): UseQueryResult<PomodoroSnapshot> {
    const query = useQuery(pomodoroSnapshotQuery);

    const setSnapshot = usePomodoroStore((state) => state.setSnapshot);
    const snapshot = query.data;
    useEffect(() => {
        if (snapshot !== undefined) {
            setSnapshot(snapshot);
        }
    }, [snapshot, setSnapshot]);

    return query;
}

/** POMO-08. Keyed under the pomodoro domain, so a completed interval's announcement refreshes both numbers. */
export function usePomodoroCounts(): UseQueryResult<PomodoroCounts> {
    return useQuery(pomodoroCountsQuery);
}

export function useStartPomodoro(): UseMutationResult<PomodoroSnapshot, Error, void> {
    return useMutation({ mutationFn: (): Promise<PomodoroSnapshot> => invoke('pomodoro:start') });
}

export function usePausePomodoro(): UseMutationResult<PomodoroSnapshot, Error, void> {
    return useMutation({ mutationFn: (): Promise<PomodoroSnapshot> => invoke('pomodoro:pause') });
}

/** Abandons the interval in flight. It completed nothing, so it records nothing and moves no counter (CORE-12). */
export function useAbortPomodoro(): UseMutationResult<PomodoroSnapshot, Error, void> {
    return useMutation({ mutationFn: (): Promise<PomodoroSnapshot> => invoke('pomodoro:abort') });
}

/** POMO-05: end a break early and go back to work. A break earns no time, so nothing is lost by ending one. */
export function useSkipBreak(): UseMutationResult<PomodoroSnapshot, Error, void> {
    return useMutation({ mutationFn: (): Promise<PomodoroSnapshot> => invoke('pomodoro:skipBreak') });
}

export interface AttributionValues {
    readonly id: number;
    readonly name: string;
    readonly durationSeconds: number;
    readonly date: LocalDate;
    readonly companyId: number | null;
    readonly note: string;
}

/*
 * POMO-02. Attribution is an ordinary session update, because the session already exists - the time was written
 * before the question was asked. The worst a failed update does is leave the row exactly as the transaction wrote
 * it, and the prompt asks again. The note is a string and never null: a null note marks a row as never having been
 * asked, so writing null back would re-arm the prompt the user just answered (see ANSWERED_WITH_NO_NOTE).
 */
export function useAttributeSession(): UseMutationResult<WorkSession, Error, AttributionValues> {
    return useMutation({
        mutationFn: (values: AttributionValues): Promise<WorkSession> => invoke('sessions:update', values)
    });
}

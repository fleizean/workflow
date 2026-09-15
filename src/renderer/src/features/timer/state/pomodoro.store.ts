/*
 * The live pomodoro snapshot and the pending auto-start, in Zustand for the reason the timer snapshot is (ARCH-03):
 * main pushes a whole snapshot on every tick, and writing that into the query cache would invalidate every
 * database-backed key once a second.
 *
 * The snapshot is stored, never computed. There is no interval counter here, no elapsed accumulator and above all
 * no completed-today count: CORE-12 is the rule that the cycle's position is a question asked of the database, and
 * a renderer-side copy of it is exactly the bug v1.2.1 shipped.
 */

import { create } from 'zustand';
import type { PomodoroInterval, PomodoroSnapshot } from '@shared/types';

/** A countdown to starting the next interval by itself, which the user can stop (POMO-07). */
export interface PendingAutoStart {
    readonly interval: PomodoroInterval;
    readonly secondsLeft: number;
}

interface PomodoroState {
    readonly snapshot: PomodoroSnapshot | null;
    readonly autoStart: PendingAutoStart | null;
    readonly setSnapshot: (snapshot: PomodoroSnapshot) => void;
    /** Replaces whatever was pending. One countdown exists at a time, so two completions cannot queue two starts. */
    readonly armAutoStart: (interval: PomodoroInterval, secondsLeft: number) => void;
    readonly tickAutoStart: () => void;
    readonly cancelAutoStart: () => void;
}

export const usePomodoroStore = create<PomodoroState>((set) => ({
    snapshot: null,
    autoStart: null,
    setSnapshot: (snapshot) => { set({ snapshot }); },
    armAutoStart: (interval, secondsLeft) => { set({ autoStart: { interval, secondsLeft } }); },
    tickAutoStart: () => {
        set((state) => ({
            autoStart: state.autoStart === null
                ? null
                : { ...state.autoStart, secondsLeft: state.autoStart.secondsLeft - 1 }
        }));
    },
    cancelAutoStart: () => { set({ autoStart: null }); }
}));

/** What leaves the feature: the value, never the store (WR-07, the rule the timer store already follows). */
export const setPomodoroSnapshot = (snapshot: PomodoroSnapshot): void => {
    usePomodoroStore.getState().setSnapshot(snapshot);
};

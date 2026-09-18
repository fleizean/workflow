/*
 * The live timer snapshot, in Zustand rather than TanStack Query (ARCH-03). Main pushes a whole snapshot once a
 * second (IPC-06); writing that into the query cache would invalidate every database-backed key every second. The
 * renderer stores what it is told and computes nothing - there is no second clock here.
 */

import { create } from 'zustand';
import type { TimerSnapshot } from '@shared/types';

interface TimerState {
    readonly snapshot: TimerSnapshot | null;
    // A function-valued property, not a method: it is selected off the store and called on its own.
    readonly setSnapshot: (snapshot: TimerSnapshot) => void;
}

export const useTimerStore = create<TimerState>((set) => ({
    snapshot: null,
    setSnapshot: (snapshot) => { set({ snapshot }); }
}));

/*
 * What leaves the feature (WR-07). The store itself stays in here: a caller holding it depends on a lifetime this
 * feature does not promise, which is how the shell came to read a snapshot that only Home kept current.
 */
export const setTimerSnapshot = (snapshot: TimerSnapshot): void => {
    useTimerStore.getState().setSnapshot(snapshot);
};

/** Read once, at the moment of asking - never subscribed to, so the titlebar does not re-render on every tick. */
export const readTimerSnapshot = (): TimerSnapshot | null => useTimerStore.getState().snapshot;

/*
 * The live timer snapshot, in Zustand rather than in TanStack Query (ARCH-03).
 *
 * Main pushes a whole snapshot once a second (IPC-06). Writing that into the query cache would invalidate and
 * re-render every consumer of a database-backed key every second; this store is the separate place high-frequency
 * state belongs. The renderer stores what it is told and computes nothing - there is no second clock here.
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

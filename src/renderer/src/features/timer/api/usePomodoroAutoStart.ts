/*
 * POMO-07: the next interval starts by itself, after a countdown, and the countdown can be stopped.
 *
 * It lives in the renderer because it is a UI affordance, not accounting: the service never starts anything on its
 * own, and nothing here counts a second of work - `pomodoro:start` is a request to main, which owns the clock. A
 * countdown that runs late because the window is hidden and Chromium throttled its timer therefore starts the next
 * interval late, which under-counts rather than inventing anything.
 *
 * "Cannot stack" is structural rather than careful: the pending start is a single field in the store, arming it
 * replaces whatever was there, and exactly one interval handle exists while it is armed. v1.2.1 called
 * `setTimeout(() => this.start(), 1000)` from inside its completion handler and kept no handle at all
 * (legacy/renderer/timer.js:167, :180), so it could neither be cancelled nor prevented from queueing twice.
 *
 * Leaving Home cancels it. That is deliberate: the alternative is an app that silently starts counting work on a
 * screen the user cannot see it on.
 */

import { useEffect, useRef } from 'react';
import { AUTO_START_DELAY_SECONDS, shouldAutoStart } from '../pomodoro-view';
import type { AutoStartSettings } from '../pomodoro-view';
import { usePomodoroStore } from '../state/pomodoro.store';
import type { PendingAutoStart } from '../state/pomodoro.store';
import { useStartPomodoro } from './usePomodoro';
import type { PomodoroSnapshot } from '@shared/types';

const TICK_MS = 1000;

export interface AutoStart {
    readonly pending: PendingAutoStart | null;
    readonly cancel: () => void;
}

/** The two settings arrive as booleans, so the effect below re-runs when an ANSWER changes and not every render. */
export function usePomodoroAutoStart(autoStartBreaks: boolean, autoStartWork: boolean): AutoStart {
    const snapshot = usePomodoroStore((state) => state.snapshot);
    const pending = usePomodoroStore((state) => state.autoStart);
    const arm = usePomodoroStore((state) => state.armAutoStart);
    const tick = usePomodoroStore((state) => state.tickAutoStart);
    const cancel = usePomodoroStore((state) => state.cancelAutoStart);
    const start = useStartPomodoro();

    // The previous snapshot, so a completion can be told from a tick. An interval that CHANGED while the cycle went
    // idle is a completion or a skipped break; an abort leaves the interval alone and arms nothing.
    const previous = useRef<PomodoroSnapshot | null>(null);
    useEffect(() => {
        if (snapshot === null) {
            return;
        }
        const before = previous.current;
        previous.current = snapshot;
        const settings: AutoStartSettings = {
            pomodoroAutoStartBreaks: autoStartBreaks,
            pomodoroAutoStartWork: autoStartWork
        };
        if (shouldAutoStart(before, snapshot, settings)) {
            arm(snapshot.interval, AUTO_START_DELAY_SECONDS);
            return;
        }
        // The user got there first, or the cycle moved somewhere a countdown no longer means anything.
        if (snapshot.status !== 'idle') {
            cancel();
        }
    }, [snapshot, autoStartBreaks, autoStartWork, arm, cancel]);

    const armed = pending !== null;
    useEffect(() => {
        if (!armed) {
            return undefined;
        }
        const handle = setInterval(() => { tick(); }, TICK_MS);
        return () => { clearInterval(handle); };
    }, [armed, tick]);

    const due = pending !== null && pending.secondsLeft <= 0;
    useEffect(() => {
        if (due) {
            cancel();
            start.mutate();
        }
        // start is a mutation object that changes identity on every render; naming it here would fire on each one.
    }, [due, cancel]);

    // Nothing may be left counting down after this screen goes away.
    useEffect(() => cancel, [cancel]);

    return { pending, cancel };
}

/*
 * Both clocks' opening values and every value after them, mounted once for the app (CR-01).
 *
 * The work timer's were mounted by TimerPage, which is one of four routes - so the titlebar, which is live on all
 * four, read a store that only Home kept current. The subscriptions and the queries belong beside DataSyncProvider
 * for the same reason data:changed does: a subscriber inside a screen stops when that screen unmounts (SPA-07).
 *
 * The pomodoro feed is here for a sharper version of the same reason: an interval completes on main's scheduler
 * while the user may be anywhere in the app, and the snapshot that arrives is what says the cycle moved - including
 * that a write failed and the interval is being held.
 */

import { useEffect } from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
    setPomodoroSnapshot, setTimerSnapshot, usePomodoroSnapshot, useTimerSnapshot
} from '@renderer/features/timer';
import { subscribePomodoroTicks } from './pomodoro-feed';
import { subscribeTimerTicks } from './timer-feed';

export function TimerProvider({ children }: { children: ReactNode }): ReactElement {
    // The opening snapshots, including a timer restored from a previous launch. Without the first one the quit
    // confirm can be handed null with a clock running, and would say the app is not counting anything.
    useTimerSnapshot();
    usePomodoroSnapshot();
    useEffect(() => subscribeTimerTicks(setTimerSnapshot), []);
    useEffect(() => subscribePomodoroTicks(setPomodoroSnapshot), []);

    return <>{children}</>;
}

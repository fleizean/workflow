/*
 * The timer's opening value and every value after it, mounted once for the app (CR-01).
 *
 * Both were mounted by TimerPage, which is one of four routes - so the titlebar, which is live on all four, read a
 * store that only Home kept current. The subscription and the query belong beside DataSyncProvider for the same
 * reason data:changed does: a subscriber inside a screen stops when that screen unmounts (SPA-07).
 */

import { useEffect } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { setTimerSnapshot, useTimerSnapshot } from '@renderer/features/timer';
import { subscribeTimerTicks } from './timer-feed';

export function TimerProvider({ children }: { children: ReactNode }): ReactElement {
    // The opening snapshot, including a timer restored from a previous launch. Without it the confirm can be
    // handed null with a clock running, and would say the app is not counting anything.
    useTimerSnapshot();
    useEffect(() => subscribeTimerTicks(setTimerSnapshot), []);

    return <>{children}</>;
}

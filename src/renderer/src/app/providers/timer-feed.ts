/*
 * The timer:tick subscription, owned by the app rather than by the Home screen (CR-01).
 *
 * It lived in TimerPage, so it was disposed on every navigation away from / and the store then held whatever the
 * last tick before the route change delivered. The quit confirm reads that store at the click, so off Home it
 * named a stale elapsed time and - worse - a persistFailing that flipped while the user was elsewhere never
 * arrived, leaving the confirm promising "Quitting keeps it" while the disk was refusing writes.
 *
 * A plain function taking its sink, rather than a hook reaching for one: that is what lets
 * tests/shell-tick-lifetime.test.ts mount this very subscription in node, push a tick through the real bridge
 * shape and read the confirm back.
 */

import { subscribe } from '@renderer/lib/ipc';
import type { TimerSnapshot } from '@shared/types';

export const subscribeTimerTicks = (write: (snapshot: TimerSnapshot) => void): (() => void) =>
    subscribe('timer:tick', write);

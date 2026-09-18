/*
 * The pomodoro:tick subscription, owned by the app rather than by the Home screen - the same rule timer-feed.ts
 * follows and for the same reason (CR-01). It matters more here: an interval completes on main's scheduler while
 * the user may be on any route, and the snapshot that arrives is what tells the renderer the cycle moved,
 * including that a write failed and the interval is being held. A torn-down subscription would leave the screen
 * reporting a pomodoro still running twenty minutes after it finished.
 */

import { subscribe } from '@renderer/lib/ipc';
import type { PomodoroSnapshot } from '@shared/types';

export const subscribePomodoroTicks = (write: (snapshot: PomodoroSnapshot) => void): (() => void) =>
    subscribe('pomodoro:tick', write);

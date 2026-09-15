// The words the notifier says, and the name a pomodoro's session is written under. Text, not behaviour: the decision
// to notify belongs to a service, and the notifier port to an adapter.

import { POMODORO_SESSION_NAME } from '@shared/constants/sessions';
import type { NotificationRequest } from './ports';
import type { PomodoroInterval } from '@shared/types';

/*
 * Re-exported from @shared/constants/sessions, where 08-D moved it: the renderer has to recognise the rows the
 * cycle writes in order to raise the attribution prompt again, and a constant only main can read cannot be the
 * thing both ends agree on. The old comment here credited legacy/renderer/timer.js:520 for the name; that file is
 * 250 lines long and writes no session at all.
 */
export { POMODORO_SESSION_NAME };

export const GOAL_NOTIFICATION: NotificationRequest = Object.freeze({
    title: 'Daily goal reached',
    body: 'You have worked your target for today.'
});

// WR-04: the clock is still counting and still on screen, but nothing it counts is reaching the disk, so a reboot
// would take the whole run with it. Raised once per run of failures - the user needs to know to write it down.
export const TIMER_NOT_SAVED_NOTIFICATION: NotificationRequest = Object.freeze({
    title: 'Time is not being saved',
    body: 'The tracked time cannot be written to the database. It is still counting, but a restart would lose it.'
});

// CR-01: the interval is over, its seconds are still held, and nothing on disk knows about them yet. Raised from
// main because a log line in a packaged app's stdout is what made this loss silent.
export const POMODORO_NOT_RECORDED_NOTIFICATION: NotificationRequest = Object.freeze({
    title: 'Pomodoro not saved',
    body: 'That interval could not be written. Its time is still counted - start the cycle again to retry.'
});

const COMPLETED: Readonly<Record<PomodoroInterval, NotificationRequest>> = Object.freeze({
    work: { title: 'Pomodoro complete', body: 'Time for a break.' },
    shortBreak: { title: 'Break over', body: 'Back to work when you are ready.' },
    longBreak: { title: 'Long break over', body: 'Back to work when you are ready.' }
});

export const notificationForCompletion = (interval: PomodoroInterval): NotificationRequest => COMPLETED[interval];

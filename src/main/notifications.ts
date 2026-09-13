// The words the notifier says, and the name a pomodoro's session is written under. Text, not behaviour: the decision
// to notify belongs to a service, and the notifier port to an adapter.

import type { NotificationRequest } from './ports';
import type { PomodoroInterval } from '@shared/types';

/** v1.2.1 wrote a completed pomodoro as a session called this (src/renderer/timer.js:520). */
export const POMODORO_SESSION_NAME = 'Pomodoro';

export const GOAL_NOTIFICATION: NotificationRequest = Object.freeze({
    title: 'Daily goal reached',
    body: 'You have worked your target for today.'
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

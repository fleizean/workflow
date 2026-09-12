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

const COMPLETED: Readonly<Record<PomodoroInterval, NotificationRequest>> = Object.freeze({
    work: { title: 'Pomodoro complete', body: 'Time for a break.' },
    shortBreak: { title: 'Break over', body: 'Back to work when you are ready.' },
    longBreak: { title: 'Long break over', body: 'Back to work when you are ready.' }
});

export const notificationForCompletion = (interval: PomodoroInterval): NotificationRequest => COMPLETED[interval];

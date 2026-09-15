/*
 * Everything the Pomodoro half of Home decides, as pure functions over the snapshot main pushed and the rows the
 * database holds. Like timer-view.ts it reads no clock and holds no counter: the cycle's position comes from
 * `completedToday`, which the service reads back out of the database on every question that could have changed it
 * (CORE-12), and which nothing in this renderer may cache - v1.2.1's count lived in renderer memory and every
 * restart and every mode toggle zeroed it (legacy/renderer/timer.js:16, :114, :124).
 *
 * Pomodoro lives inside features/timer rather than in a feature of its own on purpose. It is the same screen, it
 * shares the dial, the control geometry and the header toggle, and it rides the same exclusivity rule in the
 * composition root - at most one accumulator counts at a time. Splitting it would mean features/timer importing
 * features/pomodoro's panel and features/pomodoro importing features/timer's dial, which is a module cycle between
 * two halves of one screen.
 */

import { POMODORO_SESSION_NAME } from '@shared/constants/sessions';
import { dialDigits, ringOffsetFor } from './timer-view';
import type { DialDigits } from './timer-view';
import type { PomodoroInterval, PomodoroSnapshot, Settings, WorkSession } from '@shared/types';

const PERCENT = 100;
const SECONDS_PER_MINUTE = 60;

export type PomodoroRingColour = 'work' | 'break';

export interface PomodoroDial {
    /** legacy/pages/index.html:1396-1404's three headlines, unchanged. */
    readonly headline: string;
    readonly digits: DialDigits;
    readonly ringOffset: number;
    readonly ringColour: PomodoroRingColour;
    /** The status pill: how far into the cycle, or which break is running. */
    readonly badgeText: string;
    readonly meta: string;
    readonly isBreak: boolean;
}

const HEADLINE: Record<PomodoroInterval, string> = {
    work: 'WORK SESSION',
    shortBreak: 'SHORT BREAK',
    longBreak: 'LONG BREAK'
};

export const isBreakInterval = (interval: PomodoroInterval): boolean => interval !== 'work';

/**
 * How many work intervals of the current run of `sessionsUntilLongBreak` are already done.
 *
 * Derived from the day's completed count, never counted here. v1.2.1's badge read an in-memory counter that only
 * ever agreed with reality inside one uninterrupted app session.
 */
export function cyclePosition(completedToday: number, sessionsUntilLongBreak: number): number {
    if (sessionsUntilLongBreak <= 0) {
        return 0;
    }
    return completedToday % sessionsUntilLongBreak;
}

export function describePomodoroDial(snapshot: PomodoroSnapshot, running: boolean): PomodoroDial {
    const remaining = Math.max(0, snapshot.remainingSeconds);
    const progressPercent = snapshot.targetSeconds > 0
        ? (snapshot.elapsedSeconds / snapshot.targetSeconds) * PERCENT
        : 0;
    const isBreak = isBreakInterval(snapshot.interval);

    return {
        headline: HEADLINE[snapshot.interval],
        digits: dialDigits(remaining),
        ringOffset: ringOffsetFor(progressPercent),
        ringColour: isBreak ? 'break' : 'work',
        badgeText: badgeTextFor(snapshot),
        // legacy/pages/index.html:917-921: minutes left while it runs, otherwise that the interval is over.
        meta: running && remaining > 0
            ? String(Math.ceil(remaining / SECONDS_PER_MINUTE)) + ' min left'
            : 'Session complete',
        isBreak
    };
}

function badgeTextFor(snapshot: PomodoroSnapshot): string {
    if (snapshot.interval === 'longBreak') return 'Long Break';
    if (snapshot.interval === 'shortBreak') return 'Break';
    const done = cyclePosition(snapshot.completedToday, snapshot.sessionsUntilLongBreak);
    return String(done) + '/' + String(snapshot.sessionsUntilLongBreak);
}

/*
 * POMO-02/POMO-04: the intervals that are on disk and have not been attributed.
 *
 * The time is already safe before this function has anything to answer - the container writes the work session and
 * the pomodoro_sessions row in ONE transaction, before the completion callback returns and therefore before any
 * prompt opens (container.ts recordCompletion). So what this drives is a question, never a rescue: killing the app
 * at the prompt loses nothing, and the next launch finds the same rows and asks again.
 *
 * Oldest first, so a queue of them drains in the order they were worked.
 */
export function pendingAttributions(sessions: readonly WorkSession[]): WorkSession[] {
    return sessions
        .filter((session) =>
            session.name === POMODORO_SESSION_NAME && session.companyId === null && session.note === null)
        .slice()
        .sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);
}

/*
 * What an answered-with-nothing attribution writes into the note.
 *
 * Not null: null is the state that means "nobody has been asked yet", and pendingAttributions above is what reads
 * it. A user who worked a pomodoro for no company and has nothing to write still deserves to be asked once rather
 * than on every launch until the end of time, and an empty string is how the row records that it was asked.
 */
export const ANSWERED_WITH_NO_NOTE = '';

export function attributionNote(typed: string): string {
    return typed.trim();
}

/*
 * POMO-07. The cycle service never starts anything by itself - a completion leaves it idle on the next interval -
 * so auto-start is a decision this screen makes, out loud, with a countdown the user can stop.
 *
 * The trigger is the interval CHANGING while the cycle is idle, which is what a completion and a skipped break both
 * look like and what an abort deliberately does not: abort leaves the interval where it was, so an abandoned
 * pomodoro never auto-starts anything. A held interval - one whose write failed - never auto-starts either; the
 * user has to ask for the retry.
 *
 * v1.2.1 called setTimeout(() => this.start(), 1000) from inside completePomodoroSession with nothing holding the
 * handle (legacy/renderer/timer.js:167, :180), so nothing could cancel it and two completions in flight queued two.
 */
export const AUTO_START_DELAY_SECONDS = 5;

export interface AutoStartSettings {
    readonly pomodoroAutoStartBreaks: boolean;
    readonly pomodoroAutoStartWork: boolean;
}

export function shouldAutoStart(
    previous: PomodoroSnapshot | null,
    next: PomodoroSnapshot,
    settings: AutoStartSettings
): boolean {
    if (previous === null || next.status !== 'idle' || next.recordingFailed) {
        return false;
    }
    if (previous.interval === next.interval) {
        return false;
    }
    return next.interval === 'work' ? settings.pomodoroAutoStartWork : settings.pomodoroAutoStartBreaks;
}

/** The auto-start settings a Settings read supplies, with v1.2.1's own defaults while the read is in flight. */
export function autoStartSettingsOf(settings: Settings | undefined, fallback: AutoStartSettings): AutoStartSettings {
    if (settings === undefined) {
        return fallback;
    }
    return {
        pomodoroAutoStartBreaks: settings.pomodoroAutoStartBreaks,
        pomodoroAutoStartWork: settings.pomodoroAutoStartWork
    };
}

/** POMO-08: the two counts, in the one line the screen shows them on. */
export function countsLabel(todayCount: number, thisWeekCount: number): string {
    return String(todayCount) + ' today - ' + String(thisWeekCount) + ' this week';
}

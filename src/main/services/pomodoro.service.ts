// CORE-11/CORE-12: the pomodoro cycle as a state machine. It owns no clock and no counter - time comes from the
// ClockPort the timer service reads, and how many pomodoros today has seen comes from the database on every question
// that could have changed the answer. v1.2.1 kept the count in `pomodoroSessionCount` (src/renderer/timer.js:16),
// which every restart and every toggle of the mode reset to zero (timer.js:114, 124).

import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import { localDayOf } from '../ports';
import { TICK_MS, creditableMs } from './timer.service';
import type { LocalDate } from '@shared/types';
import type { ClockPort, RepeatingTimer, SchedulerPort } from '../ports';

export type PomodoroInterval = 'work' | 'shortBreak' | 'longBreak';
export type PomodoroStatus = 'idle' | 'running' | 'paused';

export const BREAK_INTERVALS: readonly PomodoroInterval[] = Object.freeze(['shortBreak', 'longBreak']);

export const isBreak = (interval: PomodoroInterval): boolean => interval !== 'work';

/** The four settings the cycle reads. A function, not a value, so a duration changed mid-interval takes effect. */
export interface PomodoroDurations {
    readonly workSeconds: number;
    readonly shortBreakSeconds: number;
    readonly longBreakSeconds: number;
    readonly sessionsUntilLongBreak: number;
}

export interface PomodoroSnapshot {
    readonly interval: PomodoroInterval;
    readonly status: PomodoroStatus;
    readonly elapsedSeconds: number;
    readonly targetSeconds: number;
    readonly remainingSeconds: number;
    /** The local day the count below was read for. */
    readonly date: LocalDate;
    /** Pomodoros the database holds for that day. Never incremented here - only ever assigned from the ledger. */
    readonly completedToday: number;
    readonly sessionsUntilLongBreak: number;
}

/** An interval that reached its target. The work session and the pomodoro row are the caller's one transaction. */
export interface PomodoroCompletion {
    readonly interval: PomodoroInterval;
    readonly date: LocalDate;
    /** What was actually counted, which is at least the target and at most one clamped tick more. */
    readonly elapsedSeconds: number;
}

/** Structural, so nothing here imports src/lib/db: the container passes the pomodoro repository itself. */
export interface PomodoroLedger {
    countForDay(date: LocalDate): number;
}

export interface PomodoroServiceInput {
    readonly clock: ClockPort;
    readonly scheduler: SchedulerPort;
    readonly ledger: PomodoroLedger;
    readonly durations: () => PomodoroDurations;
    /**
     * Called when an interval reaches its target, before the next one is decided. A work completion must be recorded
     * synchronously here (POMO-01's one transaction); the next interval is then derived from what the database
     * holds, so a caller that records nothing gets a count that did not move - which is the truthful answer.
     */
    readonly onCompleted: (completion: PomodoroCompletion) => void;
    /** Every state change, including each tick, so a bridge can push snapshots without this module knowing IPC. */
    readonly onChanged: (snapshot: PomodoroSnapshot) => void;
    readonly log: (line: string) => void;
}

export interface PomodoroService {
    snapshot(): PomodoroSnapshot;
    start(): PomodoroSnapshot;
    pause(): PomodoroSnapshot;
    /** Abandons the interval in flight. It completed nothing, so it records nothing and advances no counter. */
    abort(): PomodoroSnapshot;
    /** From a break only: ends it without completing it and returns to work (POMO-05's decision half). */
    skipBreak(): PomodoroSnapshot;
    tick(): PomodoroSnapshot;
    dispose(): void;
}

const positive = (value: number, fallback: number): number =>
    Number.isSafeInteger(value) && value > 0 ? value : fallback;

export function createPomodoroService(input: PomodoroServiceInput): PomodoroService {
    const { clock, durations, ledger, log, onChanged, onCompleted, scheduler } = input;

    let interval: PomodoroInterval = 'work';
    let status: PomodoroStatus = 'idle';
    let elapsedMs = 0;
    let lastTickAt = 0;
    let repeat: RepeatingTimer | undefined;

    let date = localDayOf(clock);
    let completedToday = 0;

    /** The only writer of completedToday. A read that fails keeps the last answer and is retried, never guessed. */
    function refreshCount(): void {
        try {
            completedToday = Math.max(0, ledger.countForDay(date));
        } catch (error) {
            log('pomodoro: today\'s completed count could not be read - ' +
                (error instanceof Error ? error.message : 'unknown'));
        }
    }

    refreshCount();

    function settings(): PomodoroDurations {
        const current = durations();
        return {
            workSeconds: positive(current.workSeconds, DEFAULT_SETTINGS.pomodoroWorkSeconds),
            shortBreakSeconds: positive(current.shortBreakSeconds, DEFAULT_SETTINGS.pomodoroShortBreakSeconds),
            longBreakSeconds: positive(current.longBreakSeconds, DEFAULT_SETTINGS.pomodoroLongBreakSeconds),
            // The modulo below divides by this, so a zero here would make the next interval NaN rather than wrong.
            sessionsUntilLongBreak: positive(
                current.sessionsUntilLongBreak, DEFAULT_SETTINGS.pomodoroSessionsUntilLongBreak)
        };
    }

    function targetSecondsOf(which: PomodoroInterval, current: PomodoroDurations): number {
        if (which === 'work') return current.workSeconds;
        return which === 'longBreak' ? current.longBreakSeconds : current.shortBreakSeconds;
    }

    const elapsedSeconds = (): number => Math.floor(elapsedMs / TICK_MS);

    function snapshot(): PomodoroSnapshot {
        const current = settings();
        const targetSeconds = targetSecondsOf(interval, current);
        return {
            interval,
            status,
            elapsedSeconds: elapsedSeconds(),
            targetSeconds,
            remainingSeconds: Math.max(0, targetSeconds - elapsedSeconds()),
            date,
            completedToday,
            sessionsUntilLongBreak: current.sessionsUntilLongBreak
        };
    }

    const publish = (): PomodoroSnapshot => {
        const state = snapshot();
        onChanged(state);
        return state;
    };

    function stopRepeat(): void {
        repeat?.cancel();
        repeat = undefined;
    }

    /** The local day, re-read whenever it could have rolled over. A pomodoro belongs to the day it finished on. */
    function syncDay(): void {
        const today = localDayOf(clock);
        if (today !== date) {
            date = today;
            completedToday = 0;
            refreshCount();
        }
    }

    /*
     * CORE-12, the whole of it. The break that follows a work interval is decided from the rows the database holds
     * for today, read after the caller has recorded this one - not from anything this module counted. So an aborted
     * interval, which records nothing, cannot advance the cycle, and a restart, which remembers nothing, cannot
     * reset it.
     */
    function nextAfterWork(): PomodoroInterval {
        const { sessionsUntilLongBreak } = settings();
        return completedToday > 0 && completedToday % sessionsUntilLongBreak === 0 ? 'longBreak' : 'shortBreak';
    }

    function complete(): void {
        const finished = interval;
        const completion: PomodoroCompletion = { interval: finished, date, elapsedSeconds: elapsedSeconds() };

        stopRepeat();
        status = 'idle';
        elapsedMs = 0;

        try {
            onCompleted(completion);
        } catch (error) {
            // The interval is over either way; refusing to leave it would keep counting time already accounted for.
            log('pomodoro: the completed ' + finished + ' interval could not be recorded - ' +
                (error instanceof Error ? error.message : 'unknown'));
        }

        if (finished === 'work') {
            refreshCount();
            interval = nextAfterWork();
        } else {
            interval = 'work';
        }
    }

    function onTick(): PomodoroSnapshot {
        const now = clock.monotonicNow();
        const delta = now - lastTickAt;
        lastTickAt = now;

        if (status === 'running') {
            // The timer's clamp, not a second one: no tick may credit more than two seconds of interval progress,
            // so sleep, hibernation or a stalled event loop cannot finish a pomodoro nobody worked (CORE-04).
            elapsedMs += creditableMs(delta);
            syncDay();
            if (elapsedSeconds() >= targetSecondsOf(interval, settings())) {
                complete();
            }
        }

        return publish();
    }

    return {
        snapshot,

        start() {
            if (status !== 'running') {
                lastTickAt = clock.monotonicNow();
                status = 'running';
                syncDay();
                refreshCount();
                repeat ??= scheduler.every(TICK_MS, () => { onTick(); });
            }
            return publish();
        },

        pause() {
            if (status === 'running') {
                // The part-second since the last tick is real progress; without this every pause loses up to a second.
                elapsedMs += creditableMs(clock.monotonicNow() - lastTickAt);
                lastTickAt = clock.monotonicNow();
                status = 'paused';
                stopRepeat();
            }
            return publish();
        },

        abort() {
            stopRepeat();
            status = 'idle';
            elapsedMs = 0;
            // The interval itself is unchanged: an abandoned break is still owed, and an abandoned pomodoro is not
            // one the user earned. Nothing is recorded, so the derived count cannot have moved.
            return publish();
        },

        skipBreak() {
            if (isBreak(interval)) {
                stopRepeat();
                status = 'idle';
                elapsedMs = 0;
                interval = 'work';
            }
            return publish();
        },

        tick: onTick,

        dispose() {
            stopRepeat();
        }
    };
}

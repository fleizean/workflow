// CORE-11/CORE-12: the pomodoro cycle as a state machine. It owns no clock and no counter - today's count comes from
// the database. v1.2.1 kept it in `pomodoroSessionCount` (legacy/renderer/timer.js:16), which every restart and every
// toggle of the mode reset to zero (timer.js:114, 124).

import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import { localDayOf } from '../ports';
import { PERSIST_INTERVAL_MS, TICK_MS, creditableMs } from './timer.service';
import type { LocalDate, PomodoroInterval, PomodoroSnapshot, PomodoroStatus } from '@shared/types';
import type { ClockPort, RepeatingTimer, SchedulerPort } from '../ports';

// The wire shapes are the cycle's shapes: one definition, so a field added to the schema is a compile error here.
export type { PomodoroInterval, PomodoroSnapshot, PomodoroStatus };

export const BREAK_INTERVALS: readonly PomodoroInterval[] = Object.freeze(['shortBreak', 'longBreak']);

export const isBreak = (interval: PomodoroInterval): boolean => interval !== 'work';

/** The four settings the cycle reads. A function, not a value, so a duration changed mid-interval takes effect. */
export interface PomodoroDurations {
    readonly workSeconds: number;
    readonly shortBreakSeconds: number;
    readonly longBreakSeconds: number;
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

/*
 * WR-03: what an unfinished interval had counted. The timer persists every five seconds precisely because losing
 * counted time is unacceptable, and the cycle held its seconds in memory alone - a quit at minute 49 of a 50-minute
 * interval started the next launch from zero. A count and no start timestamp, as the timer's record is.
 */
export interface PersistedPomodoroState {
    readonly interval: PomodoroInterval;
    readonly elapsedSeconds: number;
}

export interface PomodoroStateStore {
    read(): PersistedPomodoroState | null;
    write(state: PersistedPomodoroState): void;
}

export interface PomodoroServiceInput {
    readonly clock: ClockPort;
    readonly scheduler: SchedulerPort;
    readonly ledger: PomodoroLedger;
    /** Where the seconds of an unfinished interval survive a quit, a kill or a Windows shutdown (WR-03). */
    readonly store: PomodoroStateStore;
    readonly durations: () => PomodoroDurations;
    /**
     * Called when an interval reaches its target, before the next is decided. A work completion must be recorded
     * synchronously here (POMO-01's one transaction); the next interval is derived from what the database holds.
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

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : 'unknown');

export function createPomodoroService(input: PomodoroServiceInput): PomodoroService {
    const { clock, durations, ledger, log, onChanged, onCompleted, scheduler, store } = input;

    /** What a previous launch left. Never resumed, only offered - the same rule the timer follows (G3/G4). */
    function restore(): PersistedPomodoroState | null {
        try {
            return store.read();
        } catch (error) {
            log('pomodoro: the interval in flight could not be read back - ' + reasonOf(error));
            return null;
        }
    }

    const restored = restore();
    const carried = restored !== null && restored.elapsedSeconds > 0 ? restored : null;

    let interval: PomodoroInterval = carried?.interval ?? 'work';
    let status: PomodoroStatus = carried === null ? 'idle' : 'paused';
    let elapsedMs = (carried?.elapsedSeconds ?? 0) * TICK_MS;
    let lastTickAt = 0;
    let lastPersistAt = 0;
    let repeat: RepeatingTimer | undefined;
    // CR-01: set when an interval reached its target and the write that would have preserved it threw.
    let recordingFailed = false;
    let writtenSeconds = carried?.elapsedSeconds ?? 0;
    let writtenInterval: PomodoroInterval = interval;

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
            sessionsUntilLongBreak: current.sessionsUntilLongBreak,
            recordingFailed
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

    /** Reported, never thrown: a full disk must not stop the cycle the user is watching (the timer's rule). */
    function persistNow(): void {
        const seconds = elapsedSeconds();
        if (seconds === writtenSeconds && interval === writtenInterval) {
            return;
        }
        try {
            store.write({ interval, elapsedSeconds: seconds });
            writtenSeconds = seconds;
            writtenInterval = interval;
        } catch (error) {
            log('pomodoro: the counted seconds could not be saved - ' + reasonOf(error));
        }
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
     * CORE-12, the whole of it. The break that follows work is decided from the rows the database holds for today,
     * read after the caller recorded this one. So an aborted interval, which records nothing, cannot advance the
     * cycle, and a restart, which remembers nothing, cannot reset it.
     */
    function nextAfterWork(): PomodoroInterval {
        const { sessionsUntilLongBreak } = settings();
        return completedToday > 0 && completedToday % sessionsUntilLongBreak === 0 ? 'longBreak' : 'shortBreak';
    }

    function complete(): void {
        const finished = interval;
        const completion: PomodoroCompletion = { interval: finished, date, elapsedSeconds: elapsedSeconds() };

        stopRepeat();

        try {
            // CR-01: the write first, and the discard below only once it has committed. Zeroing the accumulator
            // ahead of it left a fifty-minute interval nowhere - not on disk, not in memory, not on screen.
            onCompleted(completion);
        } catch (error) {
            log('pomodoro: the completed ' + finished + ' interval could not be recorded - ' +
                (error instanceof Error ? error.message : 'unknown'));
            if (finished === 'work') {
                // Held, paused and said out loud: the seconds stay, the cycle stays on the interval that earned
                // them, and starting again retries the write rather than counting the time a second time.
                recordingFailed = true;
                status = 'paused';
                // Held on disk as well as in memory, so a kill now restores an interval that still owes its write.
                persistNow();
                return;
            }
            // A break earns no time, so a failed write destroys nothing and holding the user in it would help nobody.
        }

        recordingFailed = false;
        status = 'idle';
        elapsedMs = 0;

        if (finished === 'work') {
            refreshCount();
            interval = nextAfterWork();
        } else {
            interval = 'work';
        }
        // Immediately, not on the next debounce: the interval is on disk now, and a record still naming its seconds
        // would restore them on the next launch and let the same work be written twice.
        persistNow();
    }

    /*
     * IN-02: one read of the monotonic clock, credited and rebased together - timer.service.ts's own credit(now).
     * Two reads dropped the interval between them. The timer's clamp, not a second one: no tick may credit more than
     * two seconds of progress, so sleep or a stalled event loop cannot finish a pomodoro nobody worked (CORE-04).
     */
    function credit(now: number): void {
        elapsedMs += creditableMs(now - lastTickAt);
        lastTickAt = now;
    }

    function onTick(): PomodoroSnapshot {
        const now = clock.monotonicNow();

        if (status !== 'running') {
            lastTickAt = now;
        } else {
            credit(now);
            syncDay();
            if (elapsedSeconds() >= targetSecondsOf(interval, settings())) {
                complete();
            } else if (now - lastPersistAt >= PERSIST_INTERVAL_MS) {
                // The timer's debounce and the timer's reason: this bounds what a kill can cost to five seconds.
                lastPersistAt = now;
                persistNow();
            }
        }

        return publish();
    }

    return {
        snapshot,

        start() {
            if (status !== 'running') {
                lastTickAt = clock.monotonicNow();
                lastPersistAt = lastTickAt;
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
                credit(clock.monotonicNow());
                status = 'paused';
                stopRepeat();
                persistNow();
            }
            return publish();
        },

        abort() {
            stopRepeat();
            status = 'idle';
            elapsedMs = 0;
            // The one path that discards a held-but-unrecorded interval, and only because the user asked for it.
            recordingFailed = false;
            // The interval itself is unchanged: an abandoned break is still owed, and an abandoned pomodoro is not
            // one the user earned. Nothing is recorded, so the derived count cannot have moved.
            persistNow();
            return publish();
        },

        skipBreak() {
            if (isBreak(interval)) {
                stopRepeat();
                status = 'idle';
                elapsedMs = 0;
                recordingFailed = false;
                interval = 'work';
                persistNow();
            }
            return publish();
        },

        tick: onTick,

        dispose() {
            if (status === 'running') {
                // The part-second since the last tick is real progress, and this is the last chance to keep it.
                credit(clock.monotonicNow());
            }
            try {
                persistNow();
            } finally {
                stopRepeat();
            }
        }
    };
}

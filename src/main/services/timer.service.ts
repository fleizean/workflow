// CORE-04..07, CORE-14: the authoritative clock. It lives in main because the app hides to the tray and Chromium
// throttles a hidden window's timers to roughly once per minute, so a renderer-owned tick undercounts exactly when
// the user is most likely to be working (X1). Time is read only through ClockPort.monotonicNow.

import type { TimerMode, TimerSnapshot, TimerStatus } from '@shared/types';
import type { ClockPort, RendererBusPort, RepeatingTimer, SchedulerPort } from '../ports';

export const TICK_MS = 1000;

/*
 * The whole guarantee: no single tick can credit more than this, so no amount of sleep, hibernation, VM pause or
 * lid-close can inject phantom work time (CORE-04). Two ticks' worth, so an event loop that stalls for a second and
 * a half still credits the second and a half the user really worked - the clamp bounds invention without destroying
 * real work. It needs no OS cooperation, which is why it and not powerMonitor is the primitive.
 */
export const MAX_CREDIT_MS = 2 * TICK_MS;

/** Worst-case loss if the process is killed while running. Every status change also flushes. */
export const PERSIST_INTERVAL_MS = 5000;

/*
 * powerMonitor fires suspend and resume in pairs, but not on every sleep path. If a suspend arrives and its resume
 * never does, ticks start landing again on schedule while the service is still gated - so this many consecutive
 * ticks lift the gate. The cost of the self-heal is bounded (three seconds uncounted); the cost of not having it is
 * a clock that has silently stopped, which is the other half of the Core Value.
 */
export const GATED_TICK_LIMIT = 3;

/** What a previous launch left. Never a start timestamp, so the gap between two launches cannot be credited. */
export interface PersistedTimerState {
    readonly accumulatedSeconds: number;
    readonly mode: TimerMode;
}

export interface TimerStateStore {
    read(): PersistedTimerState;
    write(state: PersistedTimerState): void;
}

export interface TimerServiceInput {
    readonly clock: ClockPort;
    readonly scheduler: SchedulerPort;
    readonly bus: RendererBusPort;
    readonly store: TimerStateStore;
    /** A persistence failure is reported, never thrown: a full disk must not stop the clock the user is watching. */
    readonly log: (line: string) => void;
}

export interface TimerService {
    snapshot(): TimerSnapshot;
    start(): TimerSnapshot;
    pause(): TimerSnapshot;
    /** The only path that discards what was counted. Nothing else may zero it (CORE-14). */
    reset(): TimerSnapshot;
    /** Changes the mode and nothing else - not the status, and above all not the accumulated time (CORE-14, CB-1). */
    setMode(mode: TimerMode): TimerSnapshot;
    /** powerMonitor suspend, handed over by the lifecycle module: nothing is credited until resume (CORE-06). */
    suspend(): void;
    resume(): void;
    persistNow(): void;
    dispose(): void;
}

/** The clamp, exported so the pomodoro cycle shares it: two clamps would be two answers to the same question. */
export const creditableMs = (delta: number): number =>
    Number.isFinite(delta) ? Math.min(Math.max(delta, 0), MAX_CREDIT_MS) : 0;

export function createTimerService(input: TimerServiceInput): TimerService {
    const { bus, clock, log, scheduler, store } = input;

    const initial = store.read();
    let accumulatedMs = initial.accumulatedSeconds * TICK_MS;
    let mode: TimerMode = initial.mode;
    // G3/G4: a launch that finds counted time restores paused and offers it, never resumes it and never drops it.
    let status: TimerStatus = initial.accumulatedSeconds > 0 ? 'paused' : 'idle';
    let restoredFromPreviousLaunch = initial.accumulatedSeconds > 0;

    let repeat: RepeatingTimer | undefined;
    let lastTickAt = 0;
    let lastPersistAt = 0;
    let gated = false;
    let gatedTicks = 0;
    let writtenSeconds = initial.accumulatedSeconds;
    let writtenMode: TimerMode = initial.mode;

    // Truncating, never rounding: a rounded half-second would be half a second the user did not work.
    const elapsedSeconds = (): number => Math.floor(accumulatedMs / TICK_MS);

    const snapshot = (): TimerSnapshot => ({
        status, mode, elapsedSeconds: elapsedSeconds(), restoredFromPreviousLaunch
    });

    const emit = (): void => { bus.emit('timer:tick', snapshot()); };

    function persistNow(): void {
        const seconds = elapsedSeconds();
        if (seconds === writtenSeconds && mode === writtenMode) {
            return;
        }
        try {
            store.write({ accumulatedSeconds: seconds, mode });
            writtenSeconds = seconds;
            writtenMode = mode;
        } catch (error) {
            log('timer: the elapsed time could not be saved - ' + (error instanceof Error ? error.message : 'unknown'));
        }
    }

    /** Credits the clamped monotonic delta since the last observation, and rebases it. */
    function credit(now: number): void {
        const delta = now - lastTickAt;
        lastTickAt = now;
        if (status === 'running' && !gated) {
            accumulatedMs += creditableMs(delta);
        }
    }

    function onTick(): void {
        const now = clock.monotonicNow();
        if (gated) {
            gatedTicks += 1;
            if (gatedTicks >= GATED_TICK_LIMIT) {
                gated = false;
                gatedTicks = 0;
            }
            lastTickAt = now;
        } else {
            credit(now);
        }
        if (now - lastPersistAt >= PERSIST_INTERVAL_MS) {
            lastPersistAt = now;
            persistNow();
        }
        emit();
    }

    function startRepeat(): void {
        repeat ??= scheduler.every(TICK_MS, onTick);
    }

    function stopRepeat(): void {
        repeat?.cancel();
        repeat = undefined;
    }

    return {
        snapshot,

        start() {
            if (status !== 'running') {
                const now = clock.monotonicNow();
                status = 'running';
                // The user acted on the restored value, so it is no longer awaiting an answer.
                restoredFromPreviousLaunch = false;
                lastTickAt = now;
                lastPersistAt = now;
                gated = false;
                gatedTicks = 0;
                startRepeat();
                persistNow();
                emit();
            }
            return snapshot();
        },

        pause() {
            if (status === 'running') {
                // The part-second since the last tick is real work; without this every pause loses up to a second.
                credit(clock.monotonicNow());
                status = 'paused';
                stopRepeat();
                persistNow();
                emit();
            }
            return snapshot();
        },

        reset() {
            stopRepeat();
            accumulatedMs = 0;
            status = 'idle';
            restoredFromPreviousLaunch = false;
            gated = false;
            gatedTicks = 0;
            persistNow();
            emit();
            return snapshot();
        },

        setMode(next) {
            if (next !== mode) {
                // v1.2.1 called reset() here, which is the whole of CB-1. Nothing below touches accumulatedMs.
                mode = next;
                persistNow();
                emit();
            }
            return snapshot();
        },

        suspend() {
            if (!gated) {
                // Everything up to the suspend is work; everything after it, until resume, is not.
                credit(clock.monotonicNow());
                gated = true;
                gatedTicks = 0;
                persistNow();
                emit();
            }
        },

        resume() {
            // Rebasing is what makes the suspended interval exactly zero rather than merely clamped.
            lastTickAt = clock.monotonicNow();
            lastPersistAt = lastTickAt;
            gated = false;
            gatedTicks = 0;
        },

        persistNow,

        dispose() {
            if (status === 'running' && !gated) {
                credit(clock.monotonicNow());
            }
            stopRepeat();
            persistNow();
        }
    };
}

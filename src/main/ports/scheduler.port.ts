// A repeating callback, from whoever owns the host's timers. It is a port because the timer service's guarantees are
// about intervals nobody can wait for in a test - an hour asleep, a weekend closed - so the repeat has to be drivable.

export interface RepeatingTimer {
    /** Stops the repeat. Calling it more than once is harmless. */
    cancel(): void;
}

export interface SchedulerPort {
    /** Runs `run` about every `intervalMs`. About: the host decides how close, which is why every caller clamps. */
    every(intervalMs: number, run: () => void): RepeatingTimer;
}

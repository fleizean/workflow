/*
 * REPO-06: whether a newer version exists, decided here so that no part of the decision needs a network to test.
 *
 * Three guarantees this file is the whole of. It never blocks startup - start() schedules and returns, and the only
 * async value in the file is awaited inside a callback nobody holds. It never delays quit - stop() cancels the
 * timers and latches, so a request still in flight announces nothing when it lands. And it fails silently: the port
 * says undefined for every failure, and undefined is not an event.
 */

import type { RepeatingTimer, SchedulerPort } from '../ports';
import type { ReleasesPort } from '../ports/releases.port';

/** A version this service will compare: three optional numeric parts, optionally followed by a pre-release tag. */
const VERSION = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

export interface ParsedVersion {
    readonly numbers: readonly number[];
    /** The pre-release tag with its leading hyphen removed, or undefined for a plain release. */
    readonly preRelease: string | undefined;
}

/** undefined for anything this service will not reason about, which is how a malformed published version is refused. */
export function parseVersion(text: string): ParsedVersion | undefined {
    const match = VERSION.exec(text.trim());
    if (match === null) {
        return undefined;
    }
    const numbers = [match[1], match[2], match[3]].map((part) => (part === undefined ? 0 : Number(part)));
    if (numbers.some((n) => !Number.isSafeInteger(n))) {
        return undefined;
    }
    return { numbers, preRelease: match[4] };
}

function comparePreRelease(a: string | undefined, b: string | undefined): number {
    // A release outranks any pre-release of the same numbers: 2.0.0 is newer than 2.0.0-rc.1 (semver 11.3).
    if (a === b) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    const left = a.split('.');
    const right = b.split('.');
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = left[i];
        const r = right[i];
        if (l === undefined) return -1;
        if (r === undefined) return 1;
        // Numeric identifiers compare as numbers, which is the whole reason this is not a string compare; a numeric
        // identifier ranks below an alphanumeric one (semver 11.4.4), so rc.1 outranks 1.
        const leftNumeric = /^\d+$/.test(l);
        const rightNumeric = /^\d+$/.test(r);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        const step = leftNumeric ? Math.sign(Number(l) - Number(r)) : Math.sign(l < r ? -1 : l > r ? 1 : 0);
        if (step !== 0) return step;
    }
    return 0;
}

/**
 * -1, 0 or 1. Part by part as NUMBERS, because the string compare this replaces reads 1.10.0 as older than 1.9.0 -
 * and this application shipped sixteen date-stamped tags, so two-digit parts are not hypothetical.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
    for (let i = 0; i < 3; i++) {
        const step = Math.sign((a.numbers[i] ?? 0) - (b.numbers[i] ?? 0));
        if (step !== 0) return step;
    }
    return comparePreRelease(a.preRelease, b.preRelease);
}

/**
 * The published version, if it is one this user does not have. undefined when it is the same, older, unreadable, or
 * when the INSTALLED version is unreadable - an app that cannot say what it is has no business calling anything old.
 */
export function newerVersion(installed: string, published: string | undefined): string | undefined {
    if (published === undefined) {
        return undefined;
    }
    const here = parseVersion(installed);
    const there = parseVersion(published);
    if (here === undefined || there === undefined) {
        return undefined;
    }
    return compareVersions(there, here) > 0 ? published.trim() : undefined;
}

export interface UpdateCheckOptions {
    readonly releases: ReleasesPort;
    readonly scheduler: SchedulerPort;
    /** What this build says it is - app.getVersion(), which reads the packaged package.json. */
    readonly installedVersion: string;
    /** How long after start() the first check runs. Long enough that it is not competing with the first paint. */
    readonly firstDelayMs: number;
    readonly intervalMs: number;
    /** Called at most once per distinct newer version. Never called with the installed version or an older one. */
    readonly announce: (version: string) => void;
    readonly log: (line: string) => void;
}

export interface UpdateChecker {
    /** Schedules the first check and the repeat. Returns immediately; calling it twice is a no-op. */
    start(): void;
    /** Cancels both timers and silences any check already in flight. Safe before start and on every later call. */
    stop(): void;
    /** The newest version announced so far, for the tray to redraw from. */
    available(): string | undefined;
}

export function createUpdateChecker(options: UpdateCheckOptions): UpdateChecker {
    const { releases, scheduler, installedVersion, firstDelayMs, intervalMs, announce, log } = options;
    let first: RepeatingTimer | undefined;
    let repeat: RepeatingTimer | undefined;
    let stopped = false;
    let started = false;
    let announced: string | undefined;

    const check = (): void => {
        if (stopped) {
            return;
        }
        // Deliberately not awaited and deliberately not returned: nothing upstream may wait on this.
        void releases.latest().then(
            (published) => {
                // Checked again on the way back: the request outlived a quit, and the tray it would redraw is gone.
                if (stopped) return;
                const newer = newerVersion(installedVersion, published);
                if (newer === undefined || newer === announced) return;
                announced = newer;
                announce(newer);
            },
            (error: unknown) => {
                // The port's contract is that it never rejects. If one ever does, it dies here rather than as an
                // unhandled rejection that takes a main process with it.
                log('update: the releases port rejected, which it must not - ' + String(error));
            }
        );
    };

    return {
        start: () => {
            if (started || stopped) return;
            started = true;
            first = scheduler.after(firstDelayMs, check);
            repeat = scheduler.every(intervalMs, check);
        },
        stop: () => {
            stopped = true;
            first?.cancel();
            repeat?.cancel();
            first = undefined;
            repeat = undefined;
        },
        available: () => announced
    };
}

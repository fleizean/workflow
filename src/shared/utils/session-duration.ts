/*
 * What a save is allowed to write: the counted seconds plus the user's pending correction, bounded at both ends by
 * the contract's own bounds (WR-07). A negative correction cannot take a session below zero, and the total cannot
 * exceed a day - reachable in one honest way, a timer left running across a weekend with the app open.
 *
 * Here rather than in the renderer because both ends need the same answer: main bounds the pending correction when
 * it is set, and Home's dial, the Adjust dialog and the tray panel all draw what a save would write. Two copies
 * would be two answers to the same question.
 */

import { MAX_SESSION_DURATION_SECONDS } from '@shared/constants/sessions';

/** Truncating, and zero for anything that is not a number: no caller may turn a NaN into a duration. */
const whole = (seconds: number): number => (Number.isFinite(seconds) ? Math.floor(seconds) : 0);

export function savableSeconds(elapsedSeconds: number, adjustmentSeconds: number): number {
    const total = whole(elapsedSeconds) + whole(adjustmentSeconds);
    return Math.min(Math.max(total, 0), MAX_SESSION_DURATION_SECONDS);
}

/** The correction alone, bounded by what the sum above allows. What main stores, and what Adjust steps. */
export function boundedAdjustment(elapsedSeconds: number, adjustmentSeconds: number): number {
    return savableSeconds(elapsedSeconds, adjustmentSeconds) - whole(elapsedSeconds);
}

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

/**
 * `+30 min`, `-1h 05m`, or nothing at all when there is no pending correction.
 *
 * One spelling, because Home and the tray panel both draw this line and two spellings of it would be the
 * disagreement the figure above it was just given one source to end.
 */
export function adjustmentLabel(adjustmentSeconds: number): string | null {
    const seconds = whole(adjustmentSeconds);
    if (seconds === 0) {
        return null;
    }
    const sign = seconds > 0 ? '+' : '-';
    const magnitude = Math.abs(seconds);
    const hours = Math.floor(magnitude / SECONDS_PER_HOUR);
    const minutes = Math.round((magnitude % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const size = hours > 0
        ? String(hours) + 'h ' + String(minutes).padStart(2, '0') + 'm'
        : String(minutes) + ' min';
    return sign + size + ' when you save';
}

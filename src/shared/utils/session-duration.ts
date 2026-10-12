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

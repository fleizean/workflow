/*
 * Everything the Home screen decides, as pure functions over what main reported. The components below read a value
 * and draw it; nothing in them computes a time.
 *
 * A module for the reason features/history/grouping.ts is one: there is no jsdom here and no test renders a
 * component, so a decision left inside JSX is a decision nothing can run.
 *
 * No clock is read in this file. The wall clock arrives as `nowMs` and only ever NAMES a finish time; the seconds
 * come from the snapshot main pushed (X1).
 */

import { MAX_SESSION_DURATION_SECONDS } from '@shared/constants/sessions';
import { formatClockTime } from '@renderer/lib/format';
import { formatElapsed } from '@renderer/lib/duration';
import type { LocalDate, WorkSession } from '@shared/types';

/**
 * The Logged card: one day's recorded total, from the session list every screen already holds. A whole day, never
 * one session - the distinction B7 was about. v1.2.1 summed the same rows (legacy/pages/index.html:585); the sum is
 * here so it can be run.
 */
export function dayTotalOf(sessions: readonly WorkSession[], date: LocalDate): number {
    let total = 0;
    for (const session of sessions) {
        if (session.date === date) {
            total += session.durationSeconds;
        }
    }
    return total;
}

/** legacy/pages/index.html:397 - `stroke-dasharray="283"` on an r=45 circle. Carried over as the same number. */
export const RING_CIRCUMFERENCE = 283;

const PERCENT = 100;
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

/** v1.2.1 coloured the ring at these two thresholds (legacy/pages/index.html:925-932). */
export type RingTone = 'normal' | 'near' | 'complete';
const NEAR_PERCENT = 80;

export type DialDigits = readonly [string, string, string];

export interface WorkDial {
    /** v1.2.1's `h3.uppercase`, which reads EXCEEDED once the day's target is passed. */
    readonly headline: 'REMAINING' | 'EXCEEDED';
    readonly exceeded: boolean;
    readonly digits: DialDigits;
    readonly ringOffset: number;
    readonly ringTone: RingTone;
    /** The pill under the ring: an estimated finish time, or why there is not one. */
    readonly meta: string;
    /** Whether the day's own total has reached the target. Main decides the notification; this only draws. */
    readonly goalMet: boolean;
    /** What a save would write - the counted seconds plus the user's pending correction, bounded. */
    readonly savableSeconds: number;
}

export interface WorkDialInput {
    readonly dailyTargetSeconds: number;
    /** The selected day's recorded total, as the session rows hold it. */
    readonly loggedSeconds: number;
    /** What main is holding and has not been written to a row yet. */
    readonly elapsedSeconds: number;
    /** The pending correction to what a save would record. Never a counted second - see AdjustTimeForm. */
    readonly adjustmentSeconds: number;
    readonly running: boolean;
    /** Only ever used to name a clock time; never to measure one. */
    readonly nowMs: number;
    /*
     * IN-03: whether the counted seconds belong to the day this dial is about. Main counts on today and tracks the
     * day it counted on separately (timer.service.ts countedDay), so picking Yesterday used to subtract today's
     * counted seconds from yesterday's target. savableSeconds is unaffected; WR-06's congratulation rides this gate.
     */
    readonly countedOnSelectedDay: boolean;
}

/*
 * What a save is allowed to write, bounded at both ends by the contract's own bounds (WR-07): a negative correction
 * cannot take a session below zero, and the total cannot exceed a day - reachable in one honest way, a timer left
 * running across a weekend with the app open. The save form's duration field is editable precisely so that case has
 * an answer other than a refusal the user can do nothing about.
 */
export function savableSeconds(elapsedSeconds: number, adjustmentSeconds: number): number {
    const total = Math.floor(elapsedSeconds) + Math.floor(adjustmentSeconds);
    return Math.min(Math.max(total, 0), MAX_SESSION_DURATION_SECONDS);
}

/** The three groups v1.2.1 wrote into its three `.tabular-nums` spans. */
export function dialDigits(totalSeconds: number): DialDigits {
    const [hours = '00', minutes = '00', seconds = '00'] = formatElapsed(totalSeconds).split(':');
    return [hours, minutes, seconds];
}

export function ringOffsetFor(progressPercent: number): number {
    const bounded = Math.min(Math.max(progressPercent, 0), PERCENT);
    return RING_CIRCUMFERENCE - (bounded / PERCENT) * RING_CIRCUMFERENCE;
}

export function ringToneFor(progressPercent: number): RingTone {
    if (progressPercent >= PERCENT) return 'complete';
    return progressPercent >= NEAR_PERCENT ? 'near' : 'normal';
}

/*
 * v1.2.1's three answers, kept: the clock time the target would be reached at while the timer runs, a note that it
 * has been passed, and otherwise that nothing is counting. The fourth branch at legacy/pages/index.html:950 was
 * `isExceeded ? ... : 'Not running'` inside the else of `if (isExceeded)`, so its first arm was unreachable.
 */
function metaLineFor(exceeded: boolean, running: boolean, remainingSeconds: number, nowMs: number): string {
    if (exceeded) return 'Goal Exceeded!';
    if (!running) return 'Not running';
    return formatClockTime(nowMs + remainingSeconds * MS_PER_SECOND);
}

/**
 * The whole dial, in one value. v1.2.1 computed the same things inside updateTimer()
 * (legacy/pages/index.html:895-950) between four DOM writes, which is why none of it could be checked.
 */
export function describeWorkDial(input: WorkDialInput): WorkDial {
    const counted = savableSeconds(input.elapsedSeconds, input.adjustmentSeconds);
    const target = input.dailyTargetSeconds > 0 ? input.dailyTargetSeconds : 0;
    const done = input.loggedSeconds + (input.countedOnSelectedDay ? counted : 0);
    const remaining = target - done;
    const exceeded = remaining < 0;
    const progressPercent = target > 0 ? (done / target) * PERCENT : 0;

    return {
        headline: exceeded ? 'EXCEEDED' : 'REMAINING',
        exceeded,
        digits: dialDigits(Math.abs(remaining)),
        ringOffset: ringOffsetFor(progressPercent),
        ringTone: ringToneFor(progressPercent),
        meta: metaLineFor(exceeded, input.running, remaining, input.nowMs),
        goalMet: target > 0 && done >= target,
        savableSeconds: counted
    };
}

/*
 * WR-03. The confirm used to name `savableSeconds` - the accumulator plus the pending correction - while
 * `timer:reset` discards the accumulator, which the correction has never touched. It made the dialog understate the
 * loss whenever the correction was negative: -30 min with two hours counted offered to discard 90 of the 120.
 */
export interface ResetConfirm {
    readonly tone: 'error';
    readonly icon: string;
    readonly title: string;
    readonly body: string;
    readonly dismissLabel: string;
    readonly confirmLabel: string;
    readonly destructive: true;
}

export function describeResetConfirm(elapsedSeconds: number): ResetConfirm {
    return {
        tone: 'error',
        icon: 'restart_alt',
        title: 'Discard ' + formatElapsed(elapsedSeconds) + '?',
        body: 'This time has not been saved as a session. Discarding it records it nowhere, and it cannot be ' +
            'brought back. To keep it, cancel and use Save instead.',
        dismissLabel: 'Cancel',
        confirmLabel: 'Discard',
        destructive: true
    };
}

/*
 * TIMER-09. v1.2.1 drew three tiers off the streak value (legacy/pages/index.html:717-736) and wired a click handler
 * that overwrote the card with 6, 15 and 25 in turn and appended "(TEST)" to the label (:1474-1481). The tiers are
 * kept; the debug override is not, and there is no click handler on the card at all.
 */
export type StreakTier = 0 | 1 | 2 | 3;
const TIER_1_DAYS = 5;
const TIER_2_DAYS = 10;
const TIER_3_DAYS = 20;

export function streakTierOf(days: number): StreakTier {
    if (days > TIER_3_DAYS) return 3;
    if (days > TIER_2_DAYS) return 2;
    return days > TIER_1_DAYS ? 1 : 0;
}

/** legacy/pages/index.html:741 - `1 day`, otherwise `N days`. */
export function streakLabel(days: number): string {
    return days === 1 ? '1 day' : String(days) + ' days';
}

/** The header button's date, as v1.2.1 wrote it: `OCT 24`. Month is 1-12, as localDateParts reports it. */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

export function headerDateLabel(month: number, day: number): string {
    return (MONTHS[month - 1] ?? '') + ' ' + String(day);
}

/** `+30 min`, `-1h 05m`, or nothing at all when there is no pending correction. */
export function adjustmentLabel(adjustmentSeconds: number): string | null {
    if (adjustmentSeconds === 0) {
        return null;
    }
    const sign = adjustmentSeconds > 0 ? '+' : '-';
    const magnitude = Math.abs(adjustmentSeconds);
    const hours = Math.floor(magnitude / SECONDS_PER_HOUR);
    const minutes = Math.round((magnitude % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const size = hours > 0
        ? String(hours) + 'h ' + String(minutes).padStart(2, '0') + 'm'
        : String(minutes) + ' min';
    return sign + size + ' when you save';
}

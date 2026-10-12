/*
 * Everything the tray panel decides, as pure functions over what main reported. A module for the reason
 * features/timer/timer-view.ts is one: there is no jsdom in this project and no test renders a component, so a
 * decision left inside JSX is a decision nothing can run.
 *
 * No clock is read here. Every second comes from the snapshot main pushed or from a row the database holds (X1).
 */

import { adjustmentLabel, savableSeconds } from '@shared/utils/session-duration';
import { formatElapsed } from '@renderer/lib/duration';
import { formatHoursMinutes } from '@renderer/lib/format';
import type { TimerSnapshot } from '@shared/types';

const PERCENT = 100;
const WEEKDAYS = 5;
const DAYS_IN_WEEK = 7;

/**
 * PANEL-03: the weekly target, derived, because the app has no weekly target setting. Owner decision 2026-10-11:
 * the daily target times five when weekends are excluded from the streak, times seven otherwise - a user who
 * excluded weekends has already said weekends are not working days.
 *
 * THE COST, recorded here beside the code rather than in a summary nobody will read again: the setting is called
 * `excludeWeekendsFromStreak`, and its name is about the streak. This widens what it means, so a user who turned it
 * on to keep a Saturday from breaking their streak has also, without being asked, chosen a 5-day week for this bar.
 * The alternative - an explicit weekly target setting - was declined on 2026-10-11 as more surface than one bar is
 * worth. If this bar ever gets a second reader, add the setting instead of widening this one again.
 */
export function weeklyTargetSeconds(dailyTargetSeconds: number, excludeWeekendsFromStreak: boolean): number {
    const days = excludeWeekendsFromStreak ? WEEKDAYS : DAYS_IN_WEEK;
    return Math.max(dailyTargetSeconds, 0) * days;
}

export interface PanelProgress {
    /** `3h 12m / 8h` - the figures, in the panel's own words. */
    readonly figures: string;
    /** `40%`, or `--` when there is no target to be a percentage of. */
    readonly percentLabel: string;
    /** 0 to 100, for the bar's width. Clamped, because a bar cannot be 130% long. */
    readonly barPercent: number;
    readonly met: boolean;
}

/**
 * PANEL-03. The percentage is FLOORED and the label is not capped: 99.9% of a target reads 99%, because claiming
 * 100% of a day that is not done is the one error worth ruling out, and a day worked past the target reads 112%
 * rather than a second 100%. The BAR is capped, because a bar longer than its track draws nothing useful.
 */
export function describeProgress(doneSeconds: number, targetSeconds: number): PanelProgress {
    const done = Number.isFinite(doneSeconds) && doneSeconds > 0 ? Math.floor(doneSeconds) : 0;
    const target = Number.isFinite(targetSeconds) && targetSeconds > 0 ? Math.floor(targetSeconds) : 0;
    const ratio = target > 0 ? (done / target) * PERCENT : 0;
    return {
        figures: formatHoursMinutes(done) + ' / ' + formatHoursMinutes(target),
        percentLabel: target > 0 ? String(Math.floor(ratio)) + '%' : '--',
        barPercent: Math.min(Math.max(ratio, 0), PERCENT),
        met: target > 0 && done >= target
    };
}

export interface PanelTimerView {
    /** HH:MM:SS of what a save would write - the same figure, from the same function, as Home's dial. */
    readonly elapsed: string;
    readonly status: 'Running' | 'Paused' | 'Not running';
    readonly running: boolean;
    /** Whether Start/Pause may be used at all - false while the pomodoro cycle owns the clock (WR-02). */
    readonly canToggle: boolean;
    /** Whether there is counted time a save could write. */
    readonly canSave: boolean;
    /** Home's own words for a pending correction, so one timer reads as one number. Null when there is none. */
    readonly adjustment: string | null;
    /** One line saying why the controls are limited, or what the clock is holding. Null when there is nothing to say. */
    readonly note: string | null;
    /** Whether that note is a warning rather than information. */
    readonly warning: boolean;
}

/**
 * PANEL-02. Start and Pause, and no Stop - stopping needs a company and a note, and a note-required company
 * refuses an empty one.
 *
 * Pomodoro mode disables both: starting the work timer pauses the cycle (container.ts `exclusive`, WR-02), and a
 * 320px panel that silently abandons the interval the user is in the middle of would be the worst kind of
 * convenience. The panel says where the cycle is instead, and the footer is how the user gets to it.
 *
 * The READING is what a save would write, correction included, because the owner reported the alternative as a
 * bug and was right: the dial said 07:58:50 of an eight-hour target while the panel beside it said 00:00:10.
 * Both now come off the same two snapshot fields through the same savableSeconds, so they cannot drift again.
 * The STATUS stays about the clock - a correction is not a second of running time.
 */
export function describePanelTimer(snapshot: TimerSnapshot | null): PanelTimerView {
    const elapsedSeconds = snapshot?.elapsedSeconds ?? 0;
    const adjustment = snapshot?.pendingAdjustmentSeconds ?? 0;
    const savable = savableSeconds(elapsedSeconds, adjustment);
    const running = snapshot?.status === 'running';
    const pomodoro = snapshot?.mode === 'pomodoro';
    const failing = snapshot?.persistFailing === true;
    const restored = snapshot?.restoredFromPreviousLaunch === true && elapsedSeconds > 0;

    const note = failing ? 'Counting, but not saving to disk'
        : pomodoro ? 'Pomodoro cycle - open Workflow to run it'
            : restored ? 'Counted before Workflow last closed' : null;

    return {
        elapsed: formatElapsed(savable),
        status: running ? 'Running' : elapsedSeconds > 0 ? 'Paused' : 'Not running',
        running,
        canToggle: !pomodoro,
        // Home gates its Save on dial.savableSeconds, so this gates on the same thing.
        canSave: !pomodoro && savable > 0,
        adjustment: pomodoro ? null : adjustmentLabel(adjustment),
        note,
        warning: failing
    };
}

/**
 * PANEL-03: the running seconds the panel may add to the day's recorded total.
 *
 * Zero in pomodoro mode, which is WR-10: each completed interval is already its own session row, so adding the main
 * clock's accumulation would count the same wall clock twice. Under-counting makes the bar lag; over-counting makes
 * it claim a day that was not worked.
 *
 * The pending correction is in it, because Home's dial puts it in the same sum: these bars and that ring measure
 * the same day, and one of them leaving the correction out is the disagreement again one surface further down.
 */
export function countedTowardToday(snapshot: TimerSnapshot | null): number {
    if (snapshot === null || snapshot.mode !== 'work') {
        return 0;
    }
    return savableSeconds(snapshot.elapsedSeconds, snapshot.pendingAdjustmentSeconds);
}

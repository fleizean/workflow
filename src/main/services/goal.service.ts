// CORE-13: whether the daily goal has just been reached and the user should be told. Only the decision lives here -
// raising the notification and playing the sound belong to the notifier and sound adapters, which is why the service
// stays Electron-free and testable.
//
// v1.2.1 answered this twice and got it wrong both ways (index.html:944-949, 964-982). The sound was guarded by
// localStorage.lastGoalNotificationDate, which main cannot read and a cleared profile forgets; the notification was
// guarded by an in-memory `playedSound` that re-armed on every reload, so it fired once per launch. That is B1.

import { localDayOf } from '../ports';
import type { LocalDate } from '@shared/types';
import type { ClockPort } from '../ports';

export type GoalDecisionReason =
    | 'notify'
    /** goalNotification is off in settings. */
    | 'disabled'
    /** The target is not a usable number of seconds, so nothing can be measured against it. */
    | 'no-target'
    | 'below-target'
    | 'already-notified-today';

export interface GoalNotificationDecision {
    readonly notify: boolean;
    readonly date: LocalDate;
    readonly reason: GoalDecisionReason;
}

export interface GoalDecisionInput {
    readonly date: LocalDate;
    /** The whole day's tracked seconds, including whatever the timer is holding (CORE-08, B7). */
    readonly totalSecondsToday: number;
    readonly dailyTargetSeconds: number;
    readonly goalNotification: boolean;
    readonly lastNotifiedDate: LocalDate | null;
}

/** The decision as a pure function of its inputs, so a caller can ask without anything being recorded. */
export function decideGoalNotification(input: GoalDecisionInput): GoalNotificationDecision {
    const { date, dailyTargetSeconds, goalNotification, lastNotifiedDate, totalSecondsToday } = input;
    const no = (reason: GoalDecisionReason): GoalNotificationDecision => ({ notify: false, date, reason });

    if (!goalNotification) return no('disabled');
    if (!Number.isFinite(dailyTargetSeconds) || dailyTargetSeconds <= 0) return no('no-target');
    if (lastNotifiedDate === date) return no('already-notified-today');
    if (!Number.isFinite(totalSecondsToday) || totalSecondsToday < dailyTargetSeconds) return no('below-target');

    return { notify: true, date, reason: 'notify' };
}

/** The local day the notification last fired on. Structural, so nothing here imports src/lib/db. */
export interface GoalNotificationStore {
    read(): LocalDate | null;
    write(date: LocalDate): void;
}

export interface GoalSettings {
    readonly dailyTargetSeconds: number;
    readonly goalNotification: boolean;
}

export interface GoalEvaluation {
    readonly totalSecondsToday: number;
    readonly settings: GoalSettings;
}

export interface GoalService {
    /** Decides for the clock's local day, recording that day before answering yes. Safe to call every tick. */
    evaluate(input: GoalEvaluation): GoalNotificationDecision;
}

export interface GoalServiceInput {
    readonly clock: ClockPort;
    readonly store: GoalNotificationStore;
    readonly log: (line: string) => void;
}

export function createGoalService(input: GoalServiceInput): GoalService {
    const { clock, log, store } = input;

    // undefined until the store has been consulted once; after that it is the answer, refreshed only by a notify.
    let known: LocalDate | null | undefined;

    function lastNotified(): LocalDate | null {
        if (known === undefined) {
            try {
                known = store.read();
            } catch (error) {
                // Notifying twice is a nuisance; never notifying is a missing feature. Read failures pick nuisance.
                known = null;
                log('goal: the last notified day could not be read - ' +
                    (error instanceof Error ? error.message : 'unknown'));
            }
        }
        return known;
    }

    return {
        evaluate(evaluation) {
            const decision = decideGoalNotification({
                date: localDayOf(clock),
                totalSecondsToday: evaluation.totalSecondsToday,
                dailyTargetSeconds: evaluation.settings.dailyTargetSeconds,
                goalNotification: evaluation.settings.goalNotification,
                lastNotifiedDate: lastNotified()
            });

            if (decision.notify) {
                // Held whatever the write does, so a failing disk still cannot make this fire twice in one run.
                known = decision.date;
                try {
                    store.write(decision.date);
                } catch (error) {
                    log('goal: the notified day could not be saved - ' +
                        (error instanceof Error ? error.message : 'unknown'));
                }
            }

            return decision;
        }
    };
}

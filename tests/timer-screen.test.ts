/*
 * The Home screen's decisions, run rather than read. There is no jsdom in this project by decision, so nothing
 * here renders TimerPage. What IS provable is every number and word the screen puts on itself: the ring, the
 * headline, the meta line, the streak tier, the day's logged total and - the one that matters - how many seconds a
 * save would write.
 *
 * What this leaves unproven is stated in 08-C-SUMMARY.md: that the components draw what these functions return,
 * that the save button opens the form, and that the form's answer reaches `timer:stopAndSave`.
 */

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
    RING_CIRCUMFERENCE, adjustmentLabel, dayTotalOf, describeWorkDial, dialDigits, headerDateLabel, ringOffsetFor,
    describeResetConfirm, ringToneFor, savableSeconds, streakLabel, streakTierOf
} from '@renderer/features/timer/timer-view';
import { MAX_SESSION_DURATION_SECONDS } from '@shared/constants/sessions';
import { read, scriptKindFor } from './helpers/ts-imports';
import type { LocalDate, WorkSession } from '@shared/types';

const ld = (text: string): LocalDate => text as LocalDate;
const DAY = ld('2026-09-15');
const OTHER_DAY = ld('2026-09-14');

const session = (id: number, date: LocalDate, durationSeconds: number): WorkSession => ({
    id,
    name: 'Work Session',
    durationSeconds,
    date,
    companyId: null,
    note: null,
    createdAt: 1_757_000_000_000
});

/** Local noon, so no zone this suite runs in can move the clock time across a day boundary. */
const NOON_MS = new Date(2026, 8, 15, 12, 0, 0).getTime();

const HOUR = 3600;
const EIGHT_HOURS = 8 * HOUR;

const dial = (over: Partial<Parameters<typeof describeWorkDial>[0]>): ReturnType<typeof describeWorkDial> =>
    describeWorkDial({
        dailyTargetSeconds: EIGHT_HOURS,
        loggedSeconds: 0,
        elapsedSeconds: 0,
        adjustmentSeconds: 0,
        running: false,
        nowMs: NOON_MS,
        countedOnSelectedDay: true,
        ...over
    });

describe('savableSeconds: what a save is allowed to write', () => {
    it('writes what was counted when nothing was adjusted', () => {
        expect(savableSeconds(3725, 0)).toBe(3725);
    });

    it('adds the pending correction, because that is what Adjust now changes', () => {
        expect(savableSeconds(3600, 1800)).toBe(5400);
    });

    it('never goes below zero, so a correction cannot write a negative duration', () => {
        expect(savableSeconds(600, -1800)).toBe(0);
    });

    /*
     * The honest way to reach this: a timer left running across a weekend with the app open. The contract refuses a
     * duration above a day (WR-07), so without the bound the save would be rejected with nothing the user could do
     * about it except lose the lot.
     */
    it('is bounded by the one-day limit the contract enforces', () => {
        expect(savableSeconds(MAX_SESSION_DURATION_SECONDS + 10_000, 0)).toBe(MAX_SESSION_DURATION_SECONDS);
        expect(savableSeconds(0, MAX_SESSION_DURATION_SECONDS * 2)).toBe(MAX_SESSION_DURATION_SECONDS);
    });
});

describe('the dial', () => {
    it('counts DOWN to the target, as v1.2.1 did, from the day total and not from the session', () => {
        // Three hours already on disk for the day, one hour on the clock: four left of eight.
        expect(dial({ loggedSeconds: 3 * HOUR, elapsedSeconds: HOUR }).digits).toEqual(['04', '00', '00']);
    });

    it('says EXCEEDED once the day is past its target, and shows how far past', () => {
        const past = dial({ loggedSeconds: EIGHT_HOURS, elapsedSeconds: 90 });
        expect(past.headline).toBe('EXCEEDED');
        expect(past.exceeded).toBe(true);
        expect(past.digits).toEqual(['00', '01', '30']);
        expect(past.meta).toBe('Goal Exceeded!');
    });

    it('counts the pending correction into the day, so the ring and the save agree', () => {
        const adjusted = dial({ elapsedSeconds: HOUR, adjustmentSeconds: HOUR });
        expect(adjusted.savableSeconds).toBe(2 * HOUR);
        expect(adjusted.digits).toEqual(['06', '00', '00']);
    });

    it('empties the ring at nothing and fills it at the target', () => {
        expect(dial({}).ringOffset).toBe(RING_CIRCUMFERENCE);
        expect(dial({ loggedSeconds: EIGHT_HOURS }).ringOffset).toBe(0);
    });

    it('does not let the ring wind past full once the target is exceeded', () => {
        expect(dial({ loggedSeconds: EIGHT_HOURS * 3 }).ringOffset).toBe(0);
        expect(ringOffsetFor(400)).toBe(0);
        expect(ringOffsetFor(-10)).toBe(RING_CIRCUMFERENCE);
    });

    it('colours the ring at v1.2.1 two thresholds', () => {
        expect(ringToneFor(0)).toBe('normal');
        expect(ringToneFor(79.9)).toBe('normal');
        expect(ringToneFor(80)).toBe('near');
        expect(ringToneFor(99.9)).toBe('near');
        expect(ringToneFor(100)).toBe('complete');
    });

    it('names the clock time the target would be reached at, but only while the timer runs', () => {
        expect(dial({ running: false, loggedSeconds: HOUR }).meta).toBe('Not running');
        // Seven hours left at noon: 19:00, in the 24-hour shape lib/format produces.
        expect(dial({ running: true, loggedSeconds: HOUR }).meta).toBe('19:00');
    });

    it('reports the goal met on the day total, never on one session (B7)', () => {
        expect(dial({ loggedSeconds: EIGHT_HOURS - 1 }).goalMet).toBe(false);
        expect(dial({ loggedSeconds: EIGHT_HOURS }).goalMet).toBe(true);
        // Four two-hour blocks are eight hours, which is the case v1.2.1 answered no to.
        expect(dial({ loggedSeconds: 4 * 2 * HOUR }).goalMet).toBe(true);
    });

    it('does not divide by a target of zero', () => {
        const none = dial({ dailyTargetSeconds: 0, loggedSeconds: HOUR });
        expect(Number.isFinite(none.ringOffset)).toBe(true);
        expect(none.goalMet).toBe(false);
    });
});

describe('dialDigits', () => {
    it('splits into the three groups v1.2.1 wrote into three spans', () => {
        expect(dialDigits(0)).toEqual(['00', '00', '00']);
        expect(dialDigits(3725)).toEqual(['01', '02', '05']);
        expect(dialDigits(360_000)).toEqual(['100', '00', '00']);
    });
});

describe('the Logged card', () => {
    it('totals the sessions on that day and no other', () => {
        const rows = [session(1, DAY, HOUR), session(2, DAY, 1800), session(3, OTHER_DAY, HOUR)];
        expect(dayTotalOf(rows, DAY)).toBe(HOUR + 1800);
        expect(dayTotalOf(rows, OTHER_DAY)).toBe(HOUR);
    });

    it('answers zero for a day with nothing on it', () => {
        expect(dayTotalOf([], DAY)).toBe(0);
    });
});

describe('TIMER-09: the streak card', () => {
    it('reads the value out plainly, with no (TEST) anywhere in it', () => {
        expect(streakLabel(0)).toBe('0 days');
        expect(streakLabel(1)).toBe('1 day');
        expect(streakLabel(12)).toBe('12 days');
        for (const days of [0, 1, 6, 15, 25]) {
            expect(streakLabel(days)).not.toContain('TEST');
        }
    });

    it('applies v1.2.1 three tiers at v1.2.1 thresholds', () => {
        expect(streakTierOf(0)).toBe(0);
        expect(streakTierOf(5)).toBe(0);
        expect(streakTierOf(6)).toBe(1);
        expect(streakTierOf(10)).toBe(1);
        expect(streakTierOf(11)).toBe(2);
        expect(streakTierOf(20)).toBe(2);
        expect(streakTierOf(21)).toBe(3);
    });
});

describe('the header date', () => {
    it('spells the month the way v1.2.1 did', () => {
        expect(headerDateLabel(9, 15)).toBe('SEP 15');
        expect(headerDateLabel(1, 1)).toBe('JAN 1');
        expect(headerDateLabel(12, 31)).toBe('DEC 31');
    });
});

describe('the pending correction is visible whenever it is set', () => {
    it('says nothing when there is nothing pending', () => {
        expect(adjustmentLabel(0)).toBeNull();
    });

    it('names the size and the direction, so an added half hour is never silent', () => {
        expect(adjustmentLabel(1800)).toBe('+30 min when you save');
        expect(adjustmentLabel(-1800)).toBe('-30 min when you save');
        expect(adjustmentLabel(3900)).toBe('+1h 05m when you save');
    });
});

/*
 * CR-01's renderer half, as a source claim, because nothing here renders a component.
 *
 * The defect was `useState((countedSeconds / 3600).toFixed(2))`: seeded once at mount from a PROP that is
 * recomputed on every tick, so the field and the "Counted" line beside it visibly diverged while the dialog was
 * open and the submit read the frozen one. The form may hold what the user typed; it may not hold a snapshot of a
 * number that is still moving.
 */
describe('CR-01: the save form does not freeze the counted value at mount', () => {
    const SAVE_FORM = 'src/renderer/src/features/timer/components/SaveSessionForm.tsx';

    const initialisers = (rel: string): string[] => {
        const text = read(rel);
        const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true, scriptKindFor(rel));
        const found: string[] = [];
        const walk = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && node.expression.getText() === 'useState') {
                found.push(node.arguments.map((argument) => argument.getText()).join(', '));
            }
            ts.forEachChild(node, walk);
        };
        walk(source);
        return found;
    };

    it('seeds no piece of component state from the live counted value', () => {
        for (const initialiser of initialisers(SAVE_FORM)) {
            expect(initialiser, 'a tick moves this value under the form').not.toContain('countedSeconds');
        }
    });

    it('reads the counted value during render instead, so the seed follows the clock', () => {
        expect(read(SAVE_FORM)).toContain('seedDuration(countedSeconds)');
    });
});

/*
 * 08-REVIEW-TIMER WR-03. The reset confirm named `dial.savableSeconds` - elapsed plus the pending correction -
 * while `timer:reset` discards the ACCUMULATOR, which the correction has never touched. That is the whole point of
 * the Adjust redesign, and it means a negative pending correction made the confirm understate the loss: press
 * -30 min with two hours counted, then Reset, and the dialog offered to discard 90 minutes of the 120 it took.
 */
describe('WR-03: the reset confirm names what reset actually discards', () => {
    it('names the accumulator, not the corrected duration a save would write', () => {
        expect(describeResetConfirm(7200).title).toBe('Discard 02:00:00?');
        expect(savableSeconds(7200, -1800), 'the control: a save would have written this instead').toBe(5400);
    });

    it('still says it cannot be brought back, and offers Save as the way to keep it', () => {
        const confirm = describeResetConfirm(7200);
        expect(confirm.body.toLowerCase()).toContain('cannot be brought back');
        expect(confirm.body).toContain('Save');
        expect(confirm.destructive).toBe(true);
        expect(confirm.confirmLabel).toBe('Discard');
    });

    it('is what the screen asks with, and the correction does not outlive the mode it was made in', () => {
        const page = read('src/renderer/src/features/timer/TimerPage.tsx');
        expect(page).toContain('describeResetConfirm(elapsedSeconds)');
        expect(page, 'the confirm named a number reset does not touch')
            .not.toContain('formatElapsed(dial.savableSeconds)');
        // A correction made on the work dial is invisible in pomodoro mode, so it may not survive the toggle.
        expect(page).toContain('setAdjustmentSeconds(0)');
        expect(page).toContain('}, [mode]);');
    });
});

/*
 * 08-REVIEW-TIMER WR-06 and IN-03, which are one gate.
 *
 * `loggedSeconds` is the SELECTED day's recorded total and `counted` is whatever main is holding, and main counts
 * on today (timer.service.ts tracks countedDay separately so a run across midnight starts the new day at zero).
 * Blending them meant picking Yesterday while the timer ran subtracted today's counted seconds from yesterday's
 * target - and the congratulation that fires on the false-to-true transition then opened over a past date, saying
 * "You have worked your target for today."
 */
describe('WR-06 / IN-03: a day that is not today is measured by what is on disk for it', () => {
    it('leaves the counted seconds out of another day dial', () => {
        const other = dial({ loggedSeconds: 3 * HOUR, elapsedSeconds: HOUR, countedOnSelectedDay: false });
        expect(other.digits, 'today counted seconds were subtracted from another day target')
            .toEqual(['05', '00', '00']);
        expect(other.goalMet).toBe(false);
    });

    it('still reports what a save would write, because that does not depend on the day on screen', () => {
        const other = dial({ elapsedSeconds: HOUR, adjustmentSeconds: 1800, countedOnSelectedDay: false });
        expect(other.savableSeconds).toBe(HOUR + 1800);
    });

    it('counts them for today, which is the case it was always right for', () => {
        expect(dial({ loggedSeconds: 3 * HOUR, elapsedSeconds: HOUR, countedOnSelectedDay: true }).digits)
            .toEqual(['04', '00', '00']);
    });

    it('would not congratulate a past day, and forgets the transition when the date changes', () => {
        const page = read('src/renderer/src/features/timer/TimerPage.tsx');
        expect(page).toContain('countedOnSelectedDay');
        expect(page).toContain('selectedDate === today');
        // A date change is not a transition: without this, going back to Today re-arms the congratulation.
        expect(page).toContain('goalWas.current = null;');
    });
});

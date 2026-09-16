/*
 * The Pomodoro half of Home, run rather than read.
 *
 * The load-bearing one is `pendingAttributions`: it is the predicate that decides whether an interval already on
 * disk still owes the user a question, and getting it wrong in one direction asks for ever and in the other asks
 * never. The rows it reads are written by the composition root - tests/container.test.ts drives the real service
 * over a real fixture database, kills it and asserts this same predicate finds them again.
 */

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
    ANSWERED_WITH_NO_NOTE, AUTO_START_DELAY_SECONDS, attributionNote, countsLabel, cyclePosition,
    describeAbandon, describePomodoroDial, isBreakInterval, pendingAttributions, shouldAutoStart
} from '@renderer/features/timer/pomodoro-view';
import { RING_CIRCUMFERENCE } from '@renderer/features/timer/timer-view';
import { POMODORO_SESSION_NAME } from '@shared/constants/sessions';
import { read, scriptKindFor } from './helpers/ts-imports';
import type { LocalDate, PomodoroInterval, PomodoroSnapshot, PomodoroStatus, WorkSession } from '@shared/types';

const ld = (text: string): LocalDate => text as LocalDate;
const DAY = ld('2026-09-15');

const snapshot = (over: Partial<PomodoroSnapshot> = {}): PomodoroSnapshot => ({
    interval: 'work',
    status: 'idle',
    elapsedSeconds: 0,
    targetSeconds: 1500,
    remainingSeconds: 1500,
    date: DAY,
    completedToday: 0,
    sessionsUntilLongBreak: 4,
    recordingFailed: false,
    ...over
});

const session = (over: Partial<WorkSession> = {}): WorkSession => ({
    id: 1,
    name: POMODORO_SESSION_NAME,
    durationSeconds: 1500,
    date: DAY,
    companyId: null,
    note: null,
    createdAt: 1_757_000_000_000,
    ...over
});

describe('the pomodoro dial', () => {
    it('counts DOWN to the target, which is what a pomodoro is', () => {
        expect(describePomodoroDial(snapshot({ elapsedSeconds: 60, remainingSeconds: 1440 }), true).digits)
            .toEqual(['00', '24', '00']);
    });

    it('names each interval the way v1.2.1 did', () => {
        const headlines: Record<PomodoroInterval, string> = {
            work: 'WORK SESSION',
            shortBreak: 'SHORT BREAK',
            longBreak: 'LONG BREAK'
        };
        for (const interval of ['work', 'shortBreak', 'longBreak'] as const) {
            expect(describePomodoroDial(snapshot({ interval }), false).headline).toBe(headlines[interval]);
        }
    });

    it('draws work in red and either break in green, as v1.2.1 coloured the ring', () => {
        expect(describePomodoroDial(snapshot({ interval: 'work' }), true).ringColour).toBe('work');
        expect(describePomodoroDial(snapshot({ interval: 'shortBreak' }), true).ringColour).toBe('break');
        expect(describePomodoroDial(snapshot({ interval: 'longBreak' }), true).ringColour).toBe('break');
        expect(isBreakInterval('work')).toBe(false);
        expect(isBreakInterval('longBreak')).toBe(true);
    });

    it('fills the ring as the interval runs', () => {
        expect(describePomodoroDial(snapshot(), false).ringOffset).toBe(RING_CIRCUMFERENCE);
        expect(describePomodoroDial(snapshot({ elapsedSeconds: 1500, remainingSeconds: 0 }), true).ringOffset).toBe(0);
    });

    it('says how long is left while it runs, and that the interval is over when it is not', () => {
        expect(describePomodoroDial(snapshot({ remainingSeconds: 301 }), true).meta).toBe('6 min left');
        expect(describePomodoroDial(snapshot({ remainingSeconds: 301 }), false).meta).toBe('Session complete');
        expect(describePomodoroDial(snapshot({ remainingSeconds: 0 }), true).meta).toBe('Session complete');
    });

    /*
     * CORE-12 on screen. The badge reads the cycle out of the day's completed count, which the service reads back
     * from the database. v1.2.1 read an in-memory counter that every restart and every mode toggle zeroed, so the
     * badge and the long break agreed with each other and with nothing else.
     */
    it('shows how far into the cycle the day is, derived and never counted here', () => {
        expect(describePomodoroDial(snapshot({ completedToday: 0 }), false).badgeText).toBe('0/4');
        expect(describePomodoroDial(snapshot({ completedToday: 2 }), false).badgeText).toBe('2/4');
        // A fifth pomodoro is the first of the next run of four, not the fifth of this one.
        expect(describePomodoroDial(snapshot({ completedToday: 5 }), false).badgeText).toBe('1/4');
        expect(describePomodoroDial(snapshot({ interval: 'shortBreak' }), false).badgeText).toBe('Break');
        expect(describePomodoroDial(snapshot({ interval: 'longBreak' }), false).badgeText).toBe('Long Break');
    });

    it('never divides the cycle by zero', () => {
        expect(cyclePosition(7, 0)).toBe(0);
        expect(cyclePosition(7, 4)).toBe(3);
    });
});

describe('POMO-02/POMO-04: which intervals still owe the user a question', () => {
    it('finds a pomodoro that was written with no company and never asked about', () => {
        expect(pendingAttributions([session()]).map((row) => row.id)).toEqual([1]);
    });

    it('stops asking once a company has been chosen', () => {
        expect(pendingAttributions([session({ companyId: 4 })])).toEqual([]);
    });

    /*
     * The distinction the whole prompt rests on. A NULL note means nobody has been asked; an empty string means
     * somebody was asked and had nothing to say. Without it, "no company and nothing to write" would be an answer
     * the user could never finish giving - the prompt would come back on every launch for ever.
     */
    it('stops asking when the answer was "no company, nothing to say"', () => {
        expect(pendingAttributions([session({ note: ANSWERED_WITH_NO_NOTE })])).toEqual([]);
        expect(ANSWERED_WITH_NO_NOTE).not.toBeNull();
    });

    it('leaves an ordinary work session alone, whatever it is called', () => {
        expect(pendingAttributions([session({ name: 'Work Session' })])).toEqual([]);
    });

    it('asks about the oldest first, so a queue drains in the order it was worked', () => {
        const rows = [
            session({ id: 3, createdAt: 300 }),
            session({ id: 1, createdAt: 100 }),
            session({ id: 2, createdAt: 200 })
        ];
        expect(pendingAttributions(rows).map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it('trims what the user typed, so a note of spaces is no note at all', () => {
        expect(attributionNote('   ')).toBe(ANSWERED_WITH_NO_NOTE);
        expect(attributionNote('  drafted the report  ')).toBe('drafted the report');
    });
});

describe('POMO-07: auto-start', () => {
    const settings = { pomodoroAutoStartBreaks: true, pomodoroAutoStartWork: true };
    const idleOn = (interval: PomodoroInterval): PomodoroSnapshot => snapshot({ interval, status: 'idle' });
    const on = (interval: PomodoroInterval, status: PomodoroStatus): PomodoroSnapshot =>
        snapshot({ interval, status });

    it('arms after a completed work interval, which is when the cycle moves to a break', () => {
        expect(shouldAutoStart(on('work', 'running'), idleOn('shortBreak'), settings)).toBe(true);
    });

    it('arms after a completed break, which is when it moves back to work', () => {
        expect(shouldAutoStart(on('shortBreak', 'running'), idleOn('work'), settings)).toBe(true);
    });

    it('honours each setting separately, as v1.2.1 stored them', () => {
        const breaksOnly = { pomodoroAutoStartBreaks: true, pomodoroAutoStartWork: false };
        expect(shouldAutoStart(on('work', 'running'), idleOn('longBreak'), breaksOnly)).toBe(true);
        expect(shouldAutoStart(on('longBreak', 'running'), idleOn('work'), breaksOnly)).toBe(false);
    });

    it('arms nothing on an ordinary tick, so a running interval cannot queue a start', () => {
        expect(shouldAutoStart(on('work', 'running'), on('work', 'running'), settings)).toBe(false);
    });

    /*
     * abort() leaves the interval where it was and records nothing, so an abandoned pomodoro must not be followed
     * by a break that starts itself - the user stopped on purpose.
     */
    it('arms nothing after an abandoned interval', () => {
        expect(shouldAutoStart(on('work', 'running'), idleOn('work'), settings)).toBe(false);
    });

    it('arms nothing at all on the first snapshot of a launch', () => {
        expect(shouldAutoStart(null, idleOn('shortBreak'), settings)).toBe(false);
    });

    /*
     * CR-01: the interval reached its target and could not be written, so the service is holding it. Starting the
     * next one by itself would bury the retry under a break nobody asked for.
     */
    it('arms nothing while an interval is being held because its write failed', () => {
        const held = snapshot({ interval: 'shortBreak', status: 'idle', recordingFailed: true });
        expect(shouldAutoStart(on('work', 'running'), held, settings)).toBe(false);
    });

    it('leaves a window wide enough to be cancelled in', () => {
        expect(AUTO_START_DELAY_SECONDS).toBeGreaterThanOrEqual(3);
    });
});

describe('POMO-08: the counts are readable', () => {
    it('names both numbers', () => {
        expect(countsLabel(5, 23)).toBe('5 today - 23 this week');
        expect(countsLabel(0, 0)).toBe('0 today - 0 this week');
    });
});

/*
 * 08-REVIEW-TIMER CR-03. Abandon was `onAbort={() => { autoStart.cancel(); abort.mutate(); }}` - no dialog, no
 * confirm, no toast - and abort() sets elapsedMs to 0 AND recordingFailed to false, so it is the one path that
 * throws away a completed-but-unwritten interval. The button sits in the control row directly under a red banner
 * reading "Its time is still counted and nothing has been lost", and one click made that sentence false.
 *
 * The work timer's equivalent, Reset, has opened a confirm naming the amount since slice C. This is that.
 */
describe('CR-03: abandoning a pomodoro says what it costs first', () => {
    it('names the amount, the way the work timer Reset confirm does', () => {
        const warning = describeAbandon(snapshot({ status: 'running', elapsedSeconds: 1440 }));
        expect(warning.title).toBe('Discard 00:24:00?');
        expect(warning.confirmLabel).toBe('Abandon');
        expect(warning.destructive).toBe(true);
    });

    it('says that a held interval was finished and has not been written yet', () => {
        const held = describeAbandon(snapshot({ status: 'paused', elapsedSeconds: 60, recordingFailed: true }));
        expect(held.title).toBe('Discard 00:01:00?');
        expect(held.body).toContain('has not been written');
        // The banner above the button promises the time is safe; this is what keeps the promise checkable.
        expect(held.body).toContain('nowhere');
    });

    it('speaks differently for an interval that is merely in flight', () => {
        const running = describeAbandon(snapshot({ status: 'running', elapsedSeconds: 60 }));
        const held = describeAbandon(snapshot({ status: 'paused', elapsedSeconds: 60, recordingFailed: true }));
        expect(running.body).not.toBe(held.body);
        expect(running.body).toContain('nowhere');
    });

    it('asks about nothing it cannot name', () => {
        expect(describeAbandon(snapshot({ elapsedSeconds: 0 })).title).toBe('Discard 00:00:00?');
    });
});

describe('CR-03: the panel routes Abandon through the confirm', () => {
    const PANEL = 'src/renderer/src/features/timer/components/PomodoroPanel.tsx';

    const attributeText = (rel: string, name: string): string => {
        const text = read(rel);
        const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true, scriptKindFor(rel));
        let found = '';
        const walk = (node: ts.Node): void => {
            if (ts.isJsxAttribute(node) && node.name.getText() === name && node.initializer !== undefined) {
                found = node.initializer.getText();
            }
            ts.forEachChild(node, walk);
        };
        walk(source);
        return found;
    };

    it('opens a dialog and only calls the channel on a confirmed answer', () => {
        const handler = attributeText(PANEL, 'onAbort');
        expect(handler).not.toBe('');
        expect(handler).toContain('openDialog');
        expect(handler).toContain('describeAbandon');
        expect(handler).toContain('confirmed');
    });

    it('leaves Skip and the play button alone, because neither discards anything', () => {
        expect(attributeText(PANEL, 'onSkipBreak')).not.toContain('openDialog');
        expect(attributeText(PANEL, 'onToggle')).not.toContain('openDialog');
    });
});

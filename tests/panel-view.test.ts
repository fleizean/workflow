/*
 * PANEL-02/03/04: everything the tray panel decides, run rather than read.
 *
 * Three of the phase's constraints are assertions here rather than intentions: the weekly target is derived from
 * the daily one and the streak setting, the bars carry no per-tick transition, and the panel offers no Stop.
 */

import { describe, expect, it } from 'vitest';
import { read, stripCommentsAndStrings } from './helpers/ts-imports';
import { formatHoursMinutes } from '@renderer/lib/format';
import {
    countedTowardToday, describePanelTimer, describeProgress, weeklyTargetSeconds
} from '@renderer/features/panel/panel-view';
import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import type { TimerSnapshot } from '@shared/types';

const HOUR = 3600;
const EIGHT_HOURS = 8 * HOUR;

const snapshot = (fields: Partial<TimerSnapshot>): TimerSnapshot => ({
    status: 'idle',
    mode: 'work',
    elapsedSeconds: 0,
    restoredFromPreviousLaunch: false,
    persistFailing: false,
    ...fields
});

/*
 * PANEL-03's second constraint, and the one with a cost worth stating in a test as well as in the code: the app has
 * no weekly target, so the bar derives one from a setting whose name is about the streak.
 */
describe('PANEL-03: the weekly target is derived from the daily one', () => {
    it('is five daily targets when weekends are excluded from the streak', () => {
        expect(weeklyTargetSeconds(EIGHT_HOURS, true)).toBe(5 * EIGHT_HOURS);
    });

    it('is seven when they are not, because then every day is a working day', () => {
        expect(weeklyTargetSeconds(EIGHT_HOURS, false)).toBe(7 * EIGHT_HOURS);
    });

    it('reads the shipped default as a 40-hour week with weekends excluded', () => {
        // The cost, asserted: a user who excluded weekends to protect a streak also chose this denominator.
        expect(weeklyTargetSeconds(DEFAULT_SETTINGS.dailyTargetSeconds, true) / HOUR).toBe(40);
    });

    it('never answers a negative week, whatever it is handed', () => {
        expect(weeklyTargetSeconds(-1, true)).toBe(0);
        expect(weeklyTargetSeconds(0, false)).toBe(0);
    });
});

describe('PANEL-03: the figures, the percentage and the bar', () => {
    it('reads 3h 12m / 8h at 40%, which is the shape the scope asked for', () => {
        const progress = describeProgress(3 * HOUR + 12 * 60, EIGHT_HOURS);
        expect(progress.figures).toBe('3h 12m / 8h');
        expect(progress.percentLabel).toBe('40%');
        expect(progress.met).toBe(false);
    });

    /*
     * Floored, not rounded. 99.99% of a day reads 99%, because the one error worth ruling out is a panel that says
     * the target is met while the user is still a minute short of it.
     */
    it('floors the percentage, so it never claims a target that is not met', () => {
        expect(describeProgress(EIGHT_HOURS - 1, EIGHT_HOURS).percentLabel).toBe('99%');
        expect(describeProgress(EIGHT_HOURS - 1, EIGHT_HOURS).met).toBe(false);
        expect(describeProgress(EIGHT_HOURS, EIGHT_HOURS).percentLabel).toBe('100%');
        expect(describeProgress(EIGHT_HOURS, EIGHT_HOURS).met).toBe(true);
    });

    it('reports a day worked past the target honestly, and still draws a bar that fits', () => {
        const over = describeProgress(9 * HOUR, EIGHT_HOURS);
        expect(over.percentLabel, 'a day worked past the target was reported as exactly 100%').toBe('112%');
        expect(over.barPercent, 'the bar was drawn longer than its own track').toBe(100);
        expect(over.met).toBe(true);
    });

    it('says -- rather than a division by zero when there is no target', () => {
        const none = describeProgress(HOUR, 0);
        expect(none.percentLabel).toBe('--');
        expect(none.barPercent).toBe(0);
        expect(none.met).toBe(false);
    });

    it('treats nonsense as nothing instead of drawing it', () => {
        expect(describeProgress(Number.NaN, EIGHT_HOURS).barPercent).toBe(0);
        expect(describeProgress(-500, EIGHT_HOURS).percentLabel).toBe('0%');
        expect(describeProgress(HOUR, Number.POSITIVE_INFINITY).percentLabel).toBe('--');
    });

    it('words a duration the way the panel needs and the padded formatter cannot', () => {
        expect(formatHoursMinutes(0)).toBe('0m');
        expect(formatHoursMinutes(12 * 60)).toBe('12m');
        expect(formatHoursMinutes(EIGHT_HOURS)).toBe('8h');
        expect(formatHoursMinutes(8 * HOUR + 30 * 60)).toBe('8h 30m');
        // Seconds below a minute are not shown: the bars are about hours, and the elapsed reading carries seconds.
        expect(formatHoursMinutes(59)).toBe('0m');
    });
});

describe('PANEL-02: the timer row offers Start and Pause, and never a Stop', () => {
    it('reads Running while it runs and Paused while it holds something', () => {
        expect(describePanelTimer(snapshot({ status: 'running', elapsedSeconds: 61 })).status).toBe('Running');
        expect(describePanelTimer(snapshot({ status: 'paused', elapsedSeconds: 61 })).status).toBe('Paused');
        expect(describePanelTimer(snapshot({ status: 'idle' })).status).toBe('Not running');
        expect(describePanelTimer(null).status, 'a panel with no snapshot yet claimed something').toBe('Not running');
    });

    it('carries the same HH:MM:SS reading the dial does', () => {
        expect(describePanelTimer(snapshot({ elapsedSeconds: 3 * HOUR + 12 * 60 + 7 })).elapsed).toBe('03:12:07');
    });

    it('offers a save only when there is counted time to save', () => {
        expect(describePanelTimer(snapshot({ elapsedSeconds: 0 })).canSave).toBe(false);
        expect(describePanelTimer(snapshot({ elapsedSeconds: 1 })).canSave).toBe(true);
    });

    /*
     * WR-02: starting the work timer pauses the pomodoro cycle, in the composition root. A 320px panel with no
     * cycle on it must not be able to abandon the interval the user is in the middle of, so both controls are dead
     * in pomodoro mode and the panel says where the cycle is instead.
     */
    it('refuses both controls in pomodoro mode, and says why', () => {
        const pomodoro = describePanelTimer(snapshot({ mode: 'pomodoro', elapsedSeconds: 900, status: 'paused' }));
        expect(pomodoro.canToggle, 'the panel could silently abandon a running pomodoro interval').toBe(false);
        expect(pomodoro.canSave).toBe(false);
        expect(pomodoro.note).toContain('Pomodoro');
        expect(pomodoro.warning).toBe(false);
    });

    it('says the disk is refusing writes, as a warning, above everything else it could say', () => {
        const failing = describePanelTimer(
            snapshot({ status: 'running', elapsedSeconds: 2700, persistFailing: true, restoredFromPreviousLaunch: true })
        );
        expect(failing.note, 'WR-04: the panel is counting against a disk that is not keeping it')
            .toBe('Counting, but not saving to disk');
        expect(failing.warning).toBe(true);
    });

    it('says when the clock is holding time from a previous launch (G3/G4)', () => {
        const restored = describePanelTimer(snapshot({ elapsedSeconds: 500, restoredFromPreviousLaunch: true }));
        expect(restored.note).toContain('before Workflow last closed');
        expect(restored.warning).toBe(false);
        // Nothing to carry over means nothing to say about it.
        expect(describePanelTimer(snapshot({ restoredFromPreviousLaunch: true })).note).toBeNull();
    });
});

/*
 * WR-10. In pomodoro mode each completed interval is already its own session row, so adding the main clock's
 * accumulation to the day would count the same wall clock twice - the bar would claim a day that was not worked.
 */
describe('PANEL-03: what the running clock adds to the day', () => {
    it('adds the work timer\'s counted seconds, running or paused', () => {
        expect(countedTowardToday(snapshot({ status: 'running', elapsedSeconds: 125 }))).toBe(125);
        expect(countedTowardToday(snapshot({ status: 'paused', elapsedSeconds: 125 }))).toBe(125);
    });

    it('adds nothing in pomodoro mode, because those seconds are already rows', () => {
        expect(countedTowardToday(snapshot({ mode: 'pomodoro', status: 'running', elapsedSeconds: 900 }))).toBe(0);
    });

    it('adds nothing before the first snapshot, and nothing it cannot read', () => {
        expect(countedTowardToday(null)).toBe(0);
        expect(countedTowardToday(snapshot({ elapsedSeconds: Number.NaN }))).toBe(0);
        expect(countedTowardToday(snapshot({ elapsedSeconds: -5 }))).toBe(0);
    });
});

/*
 * PANEL-04's second half, which no arithmetic can state: a second is 0.003% of an eight-hour target, so an eased
 * bar is a shimmer once a second for a whole working day. The ring has a transition on purpose and this does not,
 * so the ban is scoped to the file that draws the bars.
 */
describe('PANEL-04: the bars move without easing', () => {
    const BAR = 'src/renderer/src/features/panel/components/ProgressRow.tsx';
    const MOTION = /\b(?:transition|duration-|ease-|animate-)/;

    const classListsOf = (file: string): string[] =>
        stripCommentsAndStrings(file, read(file).replace(/'\s*\+\s*'/g, '')).strings.map((token) => token.value);

    it('puts no transition, duration, easing or animation on anything in the bar row', () => {
        const offenders = classListsOf(BAR).filter((value) => MOTION.test(value));
        expect(
            offenders,
            'a second is 0.003% of an eight-hour target: an eased bar is a shimmer that says nothing, once a ' +
            'second, for the whole working day (PANEL-04).'
        ).toEqual([]);
    });

    it('would see one, and does see the one the ring carries on purpose', () => {
        expect(MOTION.test('h-1.5 w-full transition-all duration-300')).toBe(true);
        expect(
            classListsOf('src/renderer/src/features/timer/components/TimerDial.tsx').some((v) => MOTION.test(v)),
            'the ring no longer carries a transition, so this scan is not distinguishing anything'
        ).toBe(true);
    });

    it('reads class names off the bar row at all, so the scan is not vacuous', () => {
        expect(classListsOf(BAR).some((value) => /\bflex|text-|stroke|h-1\.5/.test(value))).toBe(true);
    });
});

/*
 * PANEL-02/05: the boundaries of the surface. What the panel does NOT hold is most of its value, and the two things
 * it must never hold are a way to end a session and a renderer exemption.
 */
describe('PANEL-02/05: what the panel is not', () => {
    const FEATURE = 'src/renderer/src/features/panel';
    const ROUTER = 'src/renderer/src/app/router.tsx';
    const BOTTOM_NAV = 'src/renderer/src/components/layout/BottomNav.tsx';
    const LINT = 'eslint.config.js';

    const panelSources = (): string[] => [
        FEATURE + '/PanelPage.tsx',
        FEATURE + '/panel-view.ts',
        FEATURE + '/index.ts',
        FEATURE + '/api/useMainWindow.ts',
        FEATURE + '/api/useTodayProgress.ts',
        FEATURE + '/components/PanelFooter.tsx',
        FEATURE + '/components/PanelTimerRow.tsx',
        FEATURE + '/components/ProgressRow.tsx'
    ];

    const literalsOf = (file: string): string[] =>
        stripCommentsAndStrings(file, read(file)).strings.map((token) => token.value);

    it('names no channel that could end or discard a session', () => {
        const banned = ['timer:stopAndSave', 'timer:reset', 'sessions:create', 'sessions:delete', 'sessions:deleteAll'];
        const offenders: string[] = [];
        for (const file of panelSources()) {
            for (const value of literalsOf(file)) {
                if (banned.includes(value)) offenders.push(file + ': ' + value);
            }
        }
        expect(
            offenders,
            'PANEL-02: saving needs a company and a note, and a note-required company refuses an empty one. The ' +
            'panel raises the window with the form; it does not write a session or throw one away.'
        ).toEqual([]);
    });

    /*
     * The reuse, asserted: the panel spells only the two channels no other feature needed. Start, Pause, the
     * streak, the week totals and the settings all come from the features that already read them, through their
     * index.ts - so the two surfaces cannot drift apart about what the clock is or how long the week has been.
     */
    it('spells only the two channels nothing else needed, and reuses the rest', () => {
        const channels = new Set<string>();
        for (const file of panelSources()) {
            for (const value of literalsOf(file)) {
                if (/^[a-z]+:[A-Za-z]+$/.test(value)) channels.add(value);
            }
        }
        expect([...channels].sort(), 'the panel\'s own IPC surface changed; say so here')
            .toEqual(['stats:today', 'window:showMain']);

        const page = read(FEATURE + '/PanelPage.tsx');
        for (const reused of ['useStartTimer', 'usePauseTimer', 'useStreak', 'useWeekTotals', 'useSettings']) {
            expect(page, 'the panel no longer reuses ' + reused + ', so it has forked a second copy of it')
                .toContain(reused);
        }
    });

    it('holds no companies, history or settings screen', () => {
        const offenders = panelSources().filter((file) =>
            /CompaniesPage|HistoryPage|SettingsPage|PomodoroPanel|DatePickerForm/.test(read(file)));
        expect(
            offenders,
            'the panel\'s value is that it is not the app; putting the app inside it spends that value.'
        ).toEqual([]);
    });

    it('is a route in the one document, declared outside the shell', () => {
        const router = stripCommentsAndStrings(ROUTER, read(ROUTER)).code;
        const panelAt = router.indexOf('PanelPage');
        const shellAt = router.indexOf('AppShell /');
        expect(panelAt, ROUTER + ' declares no panel route').toBeGreaterThan(-1);
        expect(shellAt, ROUTER + ' no longer mounts AppShell; teach this test its shape').toBeGreaterThan(-1);
        expect(panelAt, 'the panel route is inside AppShell, so it would carry a titlebar and a bottom navigation')
            .toBeLessThan(shellAt);
    });

    it('is not in the bottom navigation, because nothing in the app navigates to it', () => {
        expect(read(BOTTOM_NAV), 'a screen links to the panel route, which only main ever loads')
            .not.toContain('panel');
    });

    it('takes no lint exemption at all (PANEL-05)', () => {
        expect(
            read(LINT),
            'the panel is named in the renderer lint config, so it is held to something other than ARCH-03'
        ).not.toContain('features/panel');
    });
});

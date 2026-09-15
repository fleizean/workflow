/*
 * SET-01..05's arithmetic and its wording, run rather than read.
 *
 * The Settings screen is not rendered by anything here - there is no jsdom in this project, by decision - so what is
 * provable is the module the screen decides everything in. The two claims that matter most are checked against the
 * REAL service validator rather than against a restatement of it: that the screen refuses exactly the values main
 * refuses, and that it never sends a value main would refuse. A screen that guessed a bound would either promise a
 * setting that bounces at the boundary or refuse one the app accepts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
    ABOUT, DAILY_TARGET_LABEL, DESTRUCTIVE_ACTION_ID, NUMBER_FIELDS, QUICK_TARGET_HOURS, RESET_ALL_CONFIRM,
    boundOf, describeDeleteAll, describeSessionCount, draftFrom, formatTargetClock, hasChanges, isRefused,
    reviewDraft, targetSecondsOf
} from '@renderer/features/settings/settings-view';
import type { NumberField, SettingsDraft } from '@renderer/features/settings/settings-view';
import { DEFAULT_SETTINGS, SETTINGS_BOUNDS } from '@shared/constants/settings';
import { SettingsValidationError, validateSettingsPatch } from '@main/services/settings.service';
import { RENDERER_DESTRUCTIVE_TESTID } from '@main/config';
import { read, stripCommentsAndStrings } from './helpers/ts-imports';
import type { Settings } from '@shared/types';

// Criterion 3: the validator this file checks the screen against must pass with electron refusing to load.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

const stored = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

/** The draft the form starts from, with one field typed into. */
const typed = (base: Settings, key: NumberField['key'], value: string): SettingsDraft => {
    const draft = draftFrom(base);
    return { ...draft, numbers: { ...draft.numbers, [key]: value } };
};

/** What main would say about a patch: null when it accepts it, the refused key when it does not. */
const mainRefuses = (patch: Partial<Settings>): string | null => {
    try {
        validateSettingsPatch(patch);
        return null;
    } catch (error) {
        if (error instanceof SettingsValidationError) return error.key;
        throw error;
    }
};

describe('the fields are typed in units the bounds divide into', () => {
    it.each([...NUMBER_FIELDS])('$label', (field) => {
        const bound = SETTINGS_BOUNDS[field.key];
        const unit = boundOf(field);
        expect(
            [unit.min, unit.max].every(Number.isInteger),
            'the bound does not divide into the unit the field is typed in, so the screen would show a rounded ' +
            'bound and refuse a value main accepts'
        ).toBe(true);
        expect(unit.min * field.secondsPerUnit).toBe(bound.min);
        expect(unit.max * field.secondsPerUnit).toBe(bound.max);
    });

    it('covers every pomodoro setting the cycle reads, and the daily target separately', () => {
        expect([...NUMBER_FIELDS.map((field) => field.key), 'dailyTargetSeconds'].sort())
            .toEqual(Object.keys(SETTINGS_BOUNDS).sort());
    });
});

describe('SET-01/SET-02: a draft that changed nothing writes nothing', () => {
    it('sends no key at all when nothing was touched', () => {
        const base = stored();
        const review = reviewDraft(draftFrom(base), base);
        expect(isRefused(review)).toBe(false);
        expect(hasChanges(review), 'an unchanged form would rewrite every setting').toBe(false);
        expect(review.patch).toEqual({});
    });

    it('sends only the key that changed', () => {
        const base = stored();
        const review = reviewDraft(typed(base, 'pomodoroWorkSeconds', '30'), base);
        expect(review.patch).toEqual({ pomodoroWorkSeconds: 1800 });
    });

    /*
     * The silent edit this comparison exists to prevent. 90 stored seconds read as 2 minutes in a minutes box, so a
     * numeric comparison would write 120 back over a value the user never looked at.
     */
    it('leaves a stored value that is not a whole number of minutes alone until it is typed into', () => {
        const base = stored({ pomodoroWorkSeconds: 90 });
        expect(reviewDraft(draftFrom(base), base).patch).toEqual({});
        expect(reviewDraft(typed(base, 'pomodoroWorkSeconds', '3'), base).patch)
            .toEqual({ pomodoroWorkSeconds: 180 });
    });

    it('sends a toggle the moment it differs, and never the ones that do not', () => {
        const base = stored();
        const review = reviewDraft({ ...draftFrom(base), excludeWeekendsFromStreak: true }, base);
        expect(review.patch).toEqual({ excludeWeekendsFromStreak: true });
    });
});

describe('SET-01: the screen refuses exactly what the service refuses', () => {
    it.each([...NUMBER_FIELDS])('$label at both ends of its bound', (field) => {
        const one = field;
        const base = stored();
        const bound = boundOf(one);
        const at = (value: number): ReturnType<typeof reviewDraft> =>
            reviewDraft(typed(base, one.key, String(value)), base);

        expect(isRefused(at(bound.min)), 'the floor itself is a legal value').toBe(false);
        expect(isRefused(at(bound.max)), 'the cap itself is a legal value').toBe(false);
        expect(isRefused(at(bound.min - 1)), 'a value below the floor reached the service').toBe(true);
        expect(isRefused(at(bound.max + 1)), 'a value above the cap reached the service').toBe(true);

        // The control: the same four numbers, asked of the validator main actually enforces.
        const asSeconds = (value: number): Partial<Settings> => ({ [one.key]: value * one.secondsPerUnit });
        expect(mainRefuses(asSeconds(bound.min))).toBeNull();
        expect(mainRefuses(asSeconds(bound.max))).toBeNull();
        expect(mainRefuses(asSeconds(bound.min - 1))).toBe(one.key);
        expect(mainRefuses(asSeconds(bound.max + 1))).toBe(one.key);
    });

    it('never hands main a patch main would refuse, whatever was typed', () => {
        const base = stored();
        for (const field of NUMBER_FIELDS) {
            for (const value of ['0', '1', '4', '12', '13', '240', '241', '999999', '', ' ', '2.5', '-5', 'ten']) {
                const review = reviewDraft(typed(base, field.key, value), base);
                if (isRefused(review)) continue;
                expect(mainRefuses(review.patch), 'the screen sent ' + value + ' for ' + field.label).toBeNull();
            }
        }
    });

    it('says what is wrong in the unit the field is typed in, naming the bound', () => {
        const base = stored();
        const review = reviewDraft(typed(base, 'pomodoroWorkSeconds', '999'), base);
        const message = review.errors.pomodoroWorkSeconds ?? '';
        expect(message).toContain('Work Duration');
        expect(message, 'the message quotes seconds at a user typing minutes').toContain('240 minutes');
        expect(message).not.toContain('14400');
    });

    it.each([['', 'empty'], ['  ', 'blank'], ['2.5', 'fractional'], ['-5', 'negative'], ['ten', 'words']])(
        'refuses %s as a whole number rather than reading it as zero',
        (value) => {
            const base = stored();
            const review = reviewDraft(typed(base, 'pomodoroShortBreakSeconds', value), base);
            expect(review.errors.pomodoroShortBreakSeconds ?? '').toContain('whole number of minutes');
        }
    );

    /*
     * The service refuses a whole patch rather than writing part of one, "because a settings form that
     * half-applied would be harder to reason about than one refused". The screen answers the same way, so what the
     * user sees after a refusal is the form they typed - not three of their five changes applied.
     */
    it('writes nothing at all when one field is refused, however many others are good', () => {
        const base = stored();
        const draft = draftFrom(base);
        const review = reviewDraft({
            ...draft,
            dailyTargetSeconds: 25_200,
            excludeWeekendsFromStreak: true,
            numbers: { ...draft.numbers, pomodoroWorkSeconds: '30', pomodoroLongBreakSeconds: '0' }
        }, base);

        expect(isRefused(review)).toBe(true);
        expect(review.patch, 'part of a refused form was written').toEqual({});
        expect(Object.keys(review.errors)).toEqual(['pomodoroLongBreakSeconds']);
    });
});

describe('SET-02: the daily target', () => {
    it.each([[0, '00:00'], [60, '00:01'], [28_800, '08:00'], [27_000, '07:30'], [86_400, '24:00']])(
        '%i seconds reads as %s',
        (seconds, clock) => { expect(formatTargetClock(Number(seconds))).toBe(String(clock)); }
    );

    it('builds seconds out of the hours and minutes the picker collects', () => {
        expect(targetSecondsOf(7, 30)).toBe(27_000);
        expect(targetSecondsOf(24, 0)).toBe(86_400);
        expect(targetSecondsOf(-1, -1), 'a negative box is nothing, not time removed').toBe(0);
    });

    it('accepts the cap the service accepts and refuses the second past it', () => {
        const base = stored();
        const at = (seconds: number): ReturnType<typeof reviewDraft> =>
            reviewDraft({ ...draftFrom(base), dailyTargetSeconds: seconds }, base);

        expect(isRefused(at(86_400))).toBe(false);
        expect(mainRefuses({ dailyTargetSeconds: 86_400 })).toBeNull();
        expect(isRefused(at(86_460))).toBe(true);
        expect(mainRefuses({ dailyTargetSeconds: 86_460 })).toBe('dailyTargetSeconds');
        expect(isRefused(at(0)), 'a target of nothing can never be met, so the streak could never advance')
            .toBe(true);
        expect(mainRefuses({ dailyTargetSeconds: 0 })).toBe('dailyTargetSeconds');
    });

    it('names the bound as a clock, because that is what the user typed into', () => {
        const base = stored();
        const review = reviewDraft({ ...draftFrom(base), dailyTargetSeconds: 0 }, base);
        const message = review.errors.dailyTargetSeconds ?? '';
        expect(message).toContain(DAILY_TARGET_LABEL);
        expect(message).toContain('00:01');
        expect(message).toContain('24:00');
        expect(message, 'the message quotes seconds at a user who typed hours and minutes').not.toContain('86400');
    });

    it('offers the six one-tap targets v1.2.1 offered, all of them inside the bound', () => {
        expect([...QUICK_TARGET_HOURS]).toEqual([6, 7, 8, 9, 10, 12]);
        for (const hours of QUICK_TARGET_HOURS) {
            expect(mainRefuses({ dailyTargetSeconds: targetSecondsOf(hours, 0) })).toBeNull();
        }
    });
});

/*
 * Criterion 4's third clause, and the only part of it a unit test can hold: the identifier the danger-zone button
 * is reached by is the one the packaged smoke looks for. That the button actually carries it, and that
 * v1.2.1's '.mt-8.mb-8 button' finds nothing, is settled in tools/smoke-packaged.mjs.
 */
describe('the destructive action is reached by a stable identifier', () => {
    it('names the same identifier the packaged smoke looks for', () => {
        expect(DESTRUCTIVE_ACTION_ID, 'the smoke would probe for a handle the screen does not carry')
            .toBe(RENDERER_DESTRUCTIVE_TESTID);
    });

    it('asks before deleting, and says what will go', () => {
        expect(RESET_ALL_CONFIRM.confirmLabel, 'a confirm with no confirm button is an alert').toBeDefined();
        expect(RESET_ALL_CONFIRM.destructive).toBe(true);
        expect(RESET_ALL_CONFIRM.body.toLowerCase()).toContain('permanently delete');
        expect(RESET_ALL_CONFIRM.body.toLowerCase()).toContain('cannot be undone');
        expect(RESET_ALL_CONFIRM.body, 'the user is not told what survives it').toContain('Companies');
    });

    it.each([[0, 'no work session'], [1, '1 work session'], [24, '24 work sessions']])(
        'reports %i as %s',
        (count, said) => { expect(describeDeleteAll(Number(count))).toContain(String(said)); }
    );

    it('reports the number that actually went, rather than a success with no number', () => {
        expect(describeDeleteAll(3)).toBe('Deleted 3 work sessions.');
        expect(describeSessionCount(1)).toBe('1 work session');
    });
});

/*
 * Criterion 4's second clause, which is about something NOT happening: "raises no spurious 'settings saved' dialog
 * on the Pomodoro toggle".
 *
 * legacy/pages/settings.html:744 called saveSettings() from the toggle's change handler, and saveSettings ended in
 * showAlert('Settings saved successfully!') - a modal, over a switch the user had just watched move, every time
 * they touched it. Nothing about that is visible to a type or to a lint rule, and no test in this project renders a
 * component, so what is pinned here is the source: the only two dialogs this screen opens, and the fact that the
 * toggle's handler asks the mode writer and nothing else.
 */
describe('criterion 4: the pomodoro toggle announces itself with the switch, and with nothing else', () => {
    const PAGE = 'src/renderer/src/features/settings/SettingsPage.tsx';
    const FORM = 'src/renderer/src/features/settings/components/SettingsForm.tsx';
    const source = (file: string): string => stripCommentsAndStrings(file, read(file)).code;

    it('opens exactly two dialogs on this screen, and both are named requests', () => {
        const opened = [...source(PAGE).matchAll(/openDialog\(\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
        expect(
            opened.sort(),
            'a dialog written out at a call site on this screen is how "Settings saved successfully!" comes back'
        ).toEqual(['ABOUT', 'RESET_ALL_CONFIRM']);
        expect(
            source(PAGE),
            'a dialog request built inline would not be counted above'
        ).not.toMatch(/openDialog\(\s*\{/);
    });

    it('hands the toggle a handler that only asks for the mode', () => {
        const handler = /onTogglePomodoro=\{([^}]*\}[^}]*)\}/.exec(source(PAGE))?.[1] ?? '';
        expect(handler, PAGE + ' no longer passes onTogglePomodoro').not.toBe('');
        expect(handler, 'the toggle stopped going through the one writer of the pair').toContain('setMode.mutate');
        for (const forbidden of ['openDialog', 'pushToast', 'update.mutate']) {
            expect(handler, 'the toggle raises ' + forbidden + ' over a switch the user watched move')
                .not.toContain(forbidden);
        }
    });

    it('raises nothing of its own from the form the switch lives in', () => {
        for (const noise of ['openDialog', 'pushToast']) {
            expect(source(FORM), FORM + ' raises ' + noise + ' itself, so the page no longer owns what is said')
                .not.toContain(noise);
        }
    });

    it('says "saved" only where a save actually happened', () => {
        const saidOnSuccess = /onSuccess:\s*\(\)\s*=>\s*\{[^}]*pushToast\('success',\s*'Settings saved'/
            .test(read(PAGE));
        expect(saidOnSuccess, 'the success line moved off the mutation that earns it').toBe(true);
    });
});

describe('About', () => {
    it('shows the address as text, because the renderer may not open a browser window', () => {
        expect(ABOUT.body).toContain('github.com/fleizean/workflow');
        expect(ABOUT.confirmLabel, 'About is an alert, not a question').toBeUndefined();
    });
});

/*
 * Owner decision 2026-09-13: the titlebar's two buttons mean what they say. The left one hides the window and says
 * so once; X ends the process and asks first.
 *
 * The half that matters most here is the copy. Counted time survives a quit - app.quit() runs will-quit, the timer
 * credits and flushes what it holds (timer.service.ts dispose), and the next launch restores it paused (G3/G4). A
 * dialog that implied otherwise would teach the user to distrust the one guarantee this project is built on, so what
 * it claims is asserted rather than reviewed. quit-dialog.ts is a pure function of the snapshot for that reason.
 */

import { describe, expect, it } from 'vitest';
import { HIDE_NOTICE, quitDialogFor } from '../src/renderer/src/features/shell/quit-dialog';
import { read, stripCommentsAndStrings } from './helpers/ts-imports';
import type { TimerSnapshot } from '../src/shared/types';

const TITLEBAR = 'src/renderer/src/features/shell/components/TitleBar.tsx';
const CONTROLS = 'src/renderer/src/features/shell/api/useShellControls.ts';

const snapshot = (fields: Partial<TimerSnapshot>): TimerSnapshot => ({
    status: 'idle',
    mode: 'work',
    elapsedSeconds: 0,
    restoredFromPreviousLaunch: false,
    persistFailing: false,
    ...fields
});

// 01:02:03, so the formatted value is recognisable in the body rather than being a bare number.
const COUNTED = 3723;

describe('the quit confirm', () => {
    it('is a destructive confirm with Cancel as the safe answer', () => {
        const dialog = quitDialogFor(null);
        expect(dialog.confirmLabel, 'a request with no confirm label is an alert, not a confirm').toBe('Quit');
        expect(dialog.dismissLabel).toBe('Cancel');
        expect(dialog.destructive).toBe(true);
        expect(dialog.title).toBe('Quit Workflow?');
    });

    it('says the app will not keep running when there is nothing counted', () => {
        for (const state of [null, snapshot({}), snapshot({ status: 'paused', elapsedSeconds: 0 })]) {
            const dialog = quitDialogFor(state);
            expect(dialog.body).toContain('will not keep running in the tray');
            expect(dialog.body, 'there is no counted time to name').not.toMatch(/\d\d:\d\d:\d\d/);
            expect(dialog.tone).toBe('info');
        }
    });

    it('names the counted time and says it survives', () => {
        for (const state of [
            snapshot({ status: 'running', elapsedSeconds: COUNTED }),
            snapshot({ status: 'paused', elapsedSeconds: COUNTED, restoredFromPreviousLaunch: true })
        ]) {
            const dialog = quitDialogFor(state);
            expect(dialog.body, 'the counted time is not named').toContain('01:02:03');
            expect(dialog.body, 'the next launch restores it paused (G3/G4) and the dialog must say so')
                .toContain('restores it, paused');
            expect(dialog.tone).toBe('info');
        }
    });

    /*
     * The one path where the promise above cannot be made. persistFailing means the writes that make counted time
     * survive are failing right now, so the dialog stops promising and warns instead - and it is the only body that
     * ever mentions losing anything.
     */
    it('warns instead when the seconds are not reaching the disk', () => {
        const dialog = quitDialogFor(snapshot({ status: 'running', elapsedSeconds: COUNTED, persistFailing: true }));
        expect(dialog.body).toContain('01:02:03');
        expect(dialog.body).toContain('failing to save it');
        expect(dialog.body).toContain('may lose it');
        expect(dialog.tone).toBe('warning');
    });

    it('never tells the user that quitting destroys what was counted', () => {
        const bodies = [
            quitDialogFor(null),
            quitDialogFor(snapshot({ status: 'running', elapsedSeconds: COUNTED }))
        ].map((dialog) => dialog.body.toLowerCase());
        for (const body of bodies) {
            // Word-bounded: "close" contains "lose", and the idle body is allowed to say the app will close.
            expect(body, 'a false warning about the Core Value is worse than no dialog at all')
                .not.toMatch(/\b(?:lose|lost|discard|deleted?)\b/);
        }
    });
});

describe('the hide notice', () => {
    it('is an alert, not a confirm: a misunderstanding is corrected once, not re-asked', () => {
        expect(HIDE_NOTICE.confirmLabel, 'a confirm on every hide trains people to click through dialogs')
            .toBeUndefined();
        expect(HIDE_NOTICE.dismissLabel).toBe('Got it');
    });

    it('says where the window went and how to end the app', () => {
        expect(HIDE_NOTICE.body).toContain('system tray');
        // WR-03: with no tray main minimises to the taskbar instead, so the copy has to cover both.
        expect(HIDE_NOTICE.body).toContain('taskbar');
        expect(HIDE_NOTICE.body).toContain('timer keeps counting');
        expect(HIDE_NOTICE.body).toContain('X button');
    });
});

/** The wiring, read rather than run: the renderer has no DOM under vitest, so this is the available proof. */
describe('what the two buttons ask for', () => {
    const codeOf = (file: string): string => stripCommentsAndStrings(file, read(file)).code;
    const literalsOf = (file: string): string[] =>
        stripCommentsAndStrings(file, read(file)).strings.map((token) => token.value);

    it('gives the titlebar one hide button and one quit button', () => {
        const code = codeOf(TITLEBAR);
        expect(code, 'the titlebar no longer takes both actions from the shell controls')
            .toContain('const { hide, quit } = useShellControls()');
        expect(code.indexOf('onClick={hide}'), 'the hide button is gone').toBeGreaterThan(0);
        expect(code.indexOf('onClick={quit}'), 'the quit button is gone').toBeGreaterThan(0);
        expect(code.indexOf('onClick={hide}'), 'X is the right-hand button, and X is the one that quits')
            .toBeLessThan(code.indexOf('onClick={quit}'));
    });

    it('asks for a hide and a quit, and never for the retired close', () => {
        const asked = literalsOf(CONTROLS);
        expect(asked).toContain('window:hide');
        expect(asked).toContain('window:claimHideNotice');
        expect(asked).toContain('app:quit');
        expect(asked, 'the channel that meant both things is retired').not.toContain('window:close');
    });

    it('claims the notice before the window goes, not after', () => {
        // The channels are string literals, so the order they are asked in is the order they appear as literals.
        const asked = literalsOf(CONTROLS).filter((value) => value.startsWith('window:') || value === 'app:quit');
        expect(asked.indexOf('window:claimHideNotice'), 'nothing claims the notice').toBeGreaterThanOrEqual(0);
        expect(asked.indexOf('window:claimHideNotice'),
            'a notice raised after the hide is behind a window that is no longer on screen')
            .toBeLessThan(asked.indexOf('window:hide'));
    });

    it('ends the process only after the confirm says so', () => {
        const code = codeOf(CONTROLS);
        expect(code, 'the quit is not behind the dialog at all').toContain('if (await');
        expect(code.indexOf('openDialog(asked)'), 'app:quit is asked for before the dialog answers')
            .toBeLessThan(code.lastIndexOf('invoke('));
    });
});

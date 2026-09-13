/*
 * The words the titlebar's two buttons ask with. Pure functions of what main last reported, so that what they claim
 * about counted time is something a test can check rather than something a reader has to trust.
 *
 * formatElapsed is imported relatively rather than through @renderer: vitest resolves @main, @lib and @shared only
 * (D-21), and tests/shell-controls.test.ts reads these two.
 */

import type { TimerSnapshot } from '@shared/types';
import { formatElapsed } from '../../lib/duration';

/** Structurally a DialogRequest; declared here so this file pulls in no store and stays testable under node. */
export interface ShellDialog {
    readonly tone: 'info' | 'warning';
    readonly icon: string;
    readonly title: string;
    readonly body: string;
    readonly dismissLabel: string;
    readonly confirmLabel?: string;
    readonly destructive?: boolean;
}

/*
 * Shown before the first hide and never again. The tray is named first because that is where the window goes
 * whenever there is a tray to go to; with none, main minimises to the taskbar instead (WR-03), which is why the
 * taskbar is named too.
 */
export const HIDE_NOTICE: ShellDialog = {
    tone: 'info',
    icon: 'visibility_off',
    title: 'Workflow keeps running',
    body: 'The window is hidden, not closed, and the timer keeps counting. Bring it back from the Workflow icon ' +
        'in the system tray or on the taskbar. To close the app completely, use the X button.',
    dismissLabel: 'Got it'
};

const QUIT = {
    icon: 'power_settings_new',
    title: 'Quit Workflow?',
    dismissLabel: 'Cancel',
    confirmLabel: 'Quit',
    destructive: true
} as const;

/**
 * What quitting costs, told truthfully.
 *
 * Counted time survives a quit: app.quit() runs will-quit, which credits and flushes the accumulator
 * (timer.service.ts dispose) and the next launch restores it *paused* (G3/G4, readTimerState). So the dialog says so
 * rather than warning about a loss that does not happen - a false warning about the one guarantee this project is
 * built on would be worse than no dialog at all.
 *
 * The exception is real and is named: while persistFailing is set, the writes that make that true are failing, and
 * the promise cannot be made.
 */
export function quitDialogFor(snapshot: TimerSnapshot | null): ShellDialog {
    const counted = snapshot?.elapsedSeconds ?? 0;
    if (counted <= 0) {
        return { ...QUIT, tone: 'info', body: 'The app will close. It will not keep running in the tray.' };
    }
    const elapsed = formatElapsed(counted);
    if (snapshot?.persistFailing === true) {
        return {
            ...QUIT,
            tone: 'warning',
            icon: 'warning',
            body: 'Workflow has counted ' + elapsed + ' and is failing to save it to the database. Quitting now ' +
                'may lose it.'
        };
    }
    return {
        ...QUIT,
        tone: 'info',
        body: 'Workflow has counted ' + elapsed + ' that is not saved as a session yet. Quitting keeps it: the ' +
            'next launch restores it, paused, so you can still save it.'
    };
}

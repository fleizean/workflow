/*
 * Which dialog answers Escape, and what an open dialog means to the rest of the app.
 *
 * 08-REVIEW-TIMER WR-04: every mounted Modal registered its own document-level keydown listener and called
 * onDismiss with no check that it was the topmost. Two Modals meant two listeners, so one Escape dismissed both -
 * and the reachable case is the worst one on the app's most important form: a tick pushes the day past the target
 * while the Save dialog is open, the goal congratulation opens over it, and Escape to clear the congratulation
 * takes the typed session name, note and chosen date with it.
 *
 * 08-REVIEW-TIMER WR-05: Modal marks #app-shell inert, and the auto-start banner's Cancel button lives inside it.
 * A completed work interval both opens the attribution prompt and arms the countdown, and
 * DEFAULT_SETTINGS.pomodoroAutoStartBreaks is true - so in the one situation POMO-07 fires by default, the
 * countdown could not be cancelled. The stack is a module rather than a counter so both rules can be run.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
    isTopmostModal, openModalCount, popModal, pushModal
} from '@renderer/components/ui/modal-stack';
import { read } from './helpers/ts-imports';

const MODAL = 'src/renderer/src/components/ui/Modal.tsx';
const AUTO_START = 'src/renderer/src/features/timer/api/usePomodoroAutoStart.ts';

const opened: number[] = [];
const open = (): number => {
    const handle = pushModal();
    opened.push(handle);
    return handle;
};

afterEach(() => {
    while (opened.length > 0) {
        popModal(opened.pop() as number);
    }
});

describe('WR-04: only the topmost dialog answers Escape', () => {
    it('answers for the only dialog there is', () => {
        const only = open();
        expect(isTopmostModal(only)).toBe(true);
        expect(openModalCount()).toBe(1);
    });

    it('does not answer for the form a congratulation opened over', () => {
        const form = open();
        const congratulation = open();

        expect(isTopmostModal(congratulation)).toBe(true);
        expect(isTopmostModal(form), 'one Escape discarded a typed session').toBe(false);
    });

    it('hands the answer back when the dialog above it closes', () => {
        const form = open();
        const congratulation = open();
        popModal(opened.pop() as number);

        expect(congratulation).not.toBe(form);
        expect(isTopmostModal(form)).toBe(true);
        expect(openModalCount()).toBe(1);
    });

    it('answers for nobody once everything has closed', () => {
        const only = open();
        popModal(opened.pop() as number);

        expect(isTopmostModal(only)).toBe(false);
        expect(openModalCount()).toBe(0);
    });

    it('survives a dialog closing out of order, which StrictMode mount/unmount/mount produces', () => {
        const first = open();
        const second = open();
        popModal(first);
        opened.splice(opened.indexOf(first), 1);

        expect(isTopmostModal(second)).toBe(true);
        expect(openModalCount()).toBe(1);
    });

    it('ignores a handle it never issued, and a second close of the same one', () => {
        const only = open();
        popModal(-1);
        expect(openModalCount()).toBe(1);
        popModal(only);
        popModal(only);
        opened.pop();
        expect(openModalCount()).toBe(0);
    });
});

describe('WR-04/WR-05: the component reads the stack rather than a flag of its own', () => {
    it('asks whether it is topmost before dismissing on Escape', () => {
        const source = read(MODAL);
        expect(source).toContain('isTopmostModal');
        expect(source).toContain('pushModal');
        expect(source).toContain('popModal');
    });

    it('keeps the listener alive across a parent re-render (SCREENS WR-02)', () => {
        const source = read(MODAL);
        // A fresh onDismiss identity on every parent render tore the effect down and put it back, which moved
        // focus out of the field the user was typing in. The callback is read through a ref instead.
        expect(source).not.toContain('}, [onDismiss, focusable]);');
        expect(source).toContain('dismiss.current');
    });

    it('publishes how many are open, so a countdown inside the inert shell can stand down', () => {
        expect(read(MODAL)).toContain('setModalsOpen');
        expect(read(AUTO_START)).toContain('modalsOpen');
    });
});

/*
 * The one alert and the one confirm, both drawn by Modal and both raised through useUiStore.openDialog. v1.2.1
 * defined showAlert twice (legacy/pages/index.html:514 and settings.html:387) and wrote each confirm by hand,
 * which is the duplication criterion 5 removes.
 *
 * Each tone's classes are written out in full. v1.2.1 built them as bg-${color}-100, and under build-time Tailwind
 * a name that only exists after a concatenation leaves the icon circle with no colour at all (C3).
 */

import type { ReactElement } from 'react';
import Modal from './Modal';
import { useUiStore } from '@renderer/store/ui.store';
import type { Tone } from '@renderer/store/ui.store';

const TONE_ICON: Record<Tone, string> = {
    info: 'info',
    success: 'check_circle',
    warning: 'warning',
    error: 'error'
};

const CIRCLE_CLASS: Record<Tone, string> = {
    info: 'mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/20',
    success: 'mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/20',
    warning: 'mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-900/20',
    error: 'mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20'
};

const GLYPH_CLASS: Record<Tone, string> = {
    info: 'material-symbols-outlined text-3xl text-blue-600 dark:text-blue-400',
    success: 'material-symbols-outlined text-3xl text-green-600 dark:text-green-400',
    warning: 'material-symbols-outlined text-3xl text-orange-600 dark:text-orange-400',
    error: 'material-symbols-outlined text-3xl text-red-600 dark:text-red-400'
};

const TITLE_CLASS = 'mb-2 text-center text-xl font-bold text-slate-900 dark:text-white';
const BODY_CLASS = 'mb-6 text-center text-slate-600 dark:text-slate-400';
const BUTTON_BASE = 'rounded-xl py-3 font-semibold transition';
const ONLY_BUTTON_CLASS = BUTTON_BASE + ' w-full bg-primary text-white hover:bg-primary/90';
const CANCEL_CLASS = BUTTON_BASE +
    ' flex-1 bg-slate-200 text-slate-900 hover:bg-slate-300 dark:bg-slate-700 dark:text-white dark:hover:bg-slate-600';
const CONFIRM_CLASS: Record<'destructive' | 'primary', string> = {
    destructive: BUTTON_BASE + ' flex-1 bg-red-600 text-white hover:bg-red-700',
    primary: BUTTON_BASE + ' flex-1 bg-primary text-white hover:bg-primary/90'
};

export default function AlertDialog(): ReactElement | null {
    // The head of the queue only: one dialog is on screen at a time, and the next opens when this one answers.
    const dialog = useUiStore((state) => state.dialogs[0]);
    const closeDialog = useUiStore((state) => state.closeDialog);

    if (dialog === undefined) {
        return null;
    }

    const titleId = 'dialog-title-' + String(dialog.id);
    const answer = (confirmed: boolean): void => { closeDialog(dialog.id, confirmed); };

    return (
        <Modal labelledBy={titleId} onDismiss={() => { answer(false); }}>
            <div className={CIRCLE_CLASS[dialog.tone]}>
                <span className={GLYPH_CLASS[dialog.tone]}>{dialog.icon ?? TONE_ICON[dialog.tone]}</span>
            </div>
            <h2 id={titleId} className={TITLE_CLASS}>{dialog.title}</h2>
            <p className={BODY_CLASS}>{dialog.body}</p>
            {dialog.confirmLabel === undefined ? (
                // An alert: one button, which is also what Escape and the backdrop do.
                <button type="button" autoFocus className={ONLY_BUTTON_CLASS} onClick={() => { answer(true); }}>
                    {dialog.dismissLabel}
                </button>
            ) : (
                // A confirm: the safe answer holds the focus, so Enter never carries out the destructive one.
                <div className="flex gap-3">
                    <button type="button" autoFocus className={CANCEL_CLASS} onClick={() => { answer(false); }}>
                        {dialog.dismissLabel}
                    </button>
                    <button
                        type="button"
                        className={CONFIRM_CLASS[dialog.destructive === true ? 'destructive' : 'primary']}
                        onClick={() => { answer(true); }}
                    >
                        {dialog.confirmLabel}
                    </button>
                </div>
            )}
        </Modal>
    );
}

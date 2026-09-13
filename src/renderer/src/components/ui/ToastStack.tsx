/*
 * The one toast. v1.2.1 had a single showToast() in legacy/renderer/shared.js that injected a <style> element and
 * built its markup with innerHTML; this is the same appearance expressed as utilities on components, with the text
 * escaped by React rather than interpolated into HTML (S2).
 *
 * Each tone's classes are written out in full rather than assembled from a colour name. A class built by
 * concatenation produces no CSS at all under build-time Tailwind, because the scanner only ever sees source text
 * (C3), and this is the file where that temptation is strongest.
 */

import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { useUiStore } from '@renderer/store/ui.store';
import type { Toast, Tone } from '@renderer/store/ui.store';

// IN-01: v1.2.1's showToast(message, type, duration = 3000). The two visual deviations from v1.2.1 are both owner
// decisions; this one was not one, so it goes back.
const AUTO_DISMISS_MS = 3_000;
/** Must match the --animate-toast-out duration in styles/globals.css: the row leaves when the animation ends. */
const EXIT_MS = 300;

const TONE_CLASS: Record<Tone, string> = {
    info: 'flex items-center gap-3 bg-blue-500 text-white px-4 py-3 rounded-xl shadow-lg',
    success: 'flex items-center gap-3 bg-green-500 text-white px-4 py-3 rounded-xl shadow-lg',
    warning: 'flex items-center gap-3 bg-orange-500 text-white px-4 py-3 rounded-xl shadow-lg',
    error: 'flex items-center gap-3 bg-red-500 text-white px-4 py-3 rounded-xl shadow-lg'
};

const TONE_ICON: Record<Tone, string> = {
    info: 'info',
    success: 'check_circle',
    warning: 'warning',
    error: 'error'
};

// v1.2.1 slid its toast in from 400 px and back out again; the keyframes are @theme tokens now (ARCH-05).
const MOTION_CLASS: Record<'entering' | 'leaving', string> = {
    entering: 'pointer-events-auto animate-toast-in',
    leaving: 'pointer-events-auto animate-toast-out'
};

function ToastRow({ toast }: { toast: Toast }): ReactElement {
    const dismiss = useUiStore((state) => state.dismissToast);
    const remove = useUiStore((state) => state.removeToast);

    useEffect(() => {
        if (toast.leaving) {
            return undefined;
        }
        const timer = setTimeout(() => { dismiss(toast.id); }, AUTO_DISMISS_MS);
        return () => { clearTimeout(timer); };
    }, [dismiss, toast.id, toast.leaving]);

    useEffect(() => {
        if (!toast.leaving) {
            return undefined;
        }
        const timer = setTimeout(() => { remove(toast.id); }, EXIT_MS);
        return () => { clearTimeout(timer); };
    }, [remove, toast.id, toast.leaving]);

    return (
        <div className={MOTION_CLASS[toast.leaving ? 'leaving' : 'entering']}>
            <div className={TONE_CLASS[toast.tone]}>
                <span className="material-symbols-outlined text-xl">{TONE_ICON[toast.tone]}</span>
                <span className="text-sm font-medium flex-1">{toast.message}</span>
                <button
                    type="button"
                    aria-label="Dismiss"
                    className="opacity-70 hover:opacity-100 transition flex items-center justify-center"
                    onClick={() => { dismiss(toast.id); }}
                >
                    <span className="material-symbols-outlined text-lg">close</span>
                </button>
            </div>
        </div>
    );
}

export default function ToastStack(): ReactElement | null {
    const toasts = useUiStore((state) => state.toasts);
    if (toasts.length === 0) {
        return null;
    }
    return (
        <div className="fixed top-4 right-4 z-[10000] flex flex-col gap-3 max-w-[400px] pointer-events-none">
            {toasts.map((toast) => <ToastRow key={toast.id} toast={toast} />)}
        </div>
    );
}

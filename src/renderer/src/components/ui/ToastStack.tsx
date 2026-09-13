/*
 * The one toast. v1.2.1 had a single showToast() in legacy/renderer/shared.js that injected a <style> element and
 * built its markup with innerHTML; this is the same appearance expressed as utilities on components, with the text
 * escaped by React rather than interpolated into HTML (S2).
 *
 * Each kind's classes are written out in full rather than assembled from a colour name. A class built by
 * concatenation produces no CSS at all under build-time Tailwind, because the scanner only ever sees source text
 * (C3), and this is the file where that temptation is strongest.
 */

import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { useUiStore } from '@renderer/store/ui.store';
import type { Toast, ToastKind } from '@renderer/store/ui.store';

const AUTO_DISMISS_MS = 5_000;

const KIND_CLASS: Record<ToastKind, string> = {
    info: 'flex items-center gap-3 bg-blue-500 text-white px-4 py-3 rounded-xl shadow-lg',
    success: 'flex items-center gap-3 bg-green-500 text-white px-4 py-3 rounded-xl shadow-lg',
    warning: 'flex items-center gap-3 bg-orange-500 text-white px-4 py-3 rounded-xl shadow-lg',
    error: 'flex items-center gap-3 bg-red-500 text-white px-4 py-3 rounded-xl shadow-lg'
};

const KIND_ICON: Record<ToastKind, string> = {
    info: 'info',
    success: 'check_circle',
    warning: 'warning',
    error: 'error'
};

function ToastRow({ toast }: { toast: Toast }): ReactElement {
    const dismiss = useUiStore((state) => state.dismissToast);

    useEffect(() => {
        const timer = setTimeout(() => { dismiss(toast.id); }, AUTO_DISMISS_MS);
        return () => { clearTimeout(timer); };
    }, [dismiss, toast.id]);

    return (
        <div className="pointer-events-auto">
            <div className={KIND_CLASS[toast.kind]}>
                <span className="material-symbols-outlined text-xl">{KIND_ICON[toast.kind]}</span>
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

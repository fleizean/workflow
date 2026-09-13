/*
 * The one modal. Everything that darkens the screen is this component with different children - v1.2.1 hand-built
 * an overlay at six sites across three pages, and two of them also carried their own copy of showAlert (criterion 5).
 *
 * It decides nothing about what is inside it: the alert, the confirm and whatever Phase 8 adds are callers.
 */

import { useEffect } from 'react';
import type { MouseEvent, ReactElement, ReactNode } from 'react';

const OVERLAY_CLASS = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4';
const PANEL_CLASS = 'w-80 max-w-full rounded-2xl bg-white p-6 shadow-2xl dark:bg-surface-dark animate-modal-in';

interface ModalProps {
    /** The id of the element naming this dialog, so a screen reader announces it rather than the first button. */
    readonly labelledBy: string;
    /** Escape and a click on the backdrop, which are the same answer as the dismiss button. */
    readonly onDismiss: () => void;
    readonly children: ReactNode;
}

export default function Modal({ labelledBy, onDismiss, children }: ModalProps): ReactElement {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                onDismiss();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('keydown', onKeyDown); };
    }, [onDismiss]);

    // mousedown, not click: a drag that starts inside the panel and ends on the backdrop is not a dismissal.
    const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
        if (event.target === event.currentTarget) {
            onDismiss();
        }
    };

    return (
        <div className={OVERLAY_CLASS} onMouseDown={onBackdrop}>
            <div role="dialog" aria-modal="true" aria-labelledby={labelledBy} className={PANEL_CLASS}>
                {children}
            </div>
        </div>
    );
}

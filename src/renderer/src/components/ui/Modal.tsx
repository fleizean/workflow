/*
 * The one modal. Everything that darkens the screen is this component with different children - v1.2.1 hand-built
 * an overlay at six sites across three pages, and two of them also carried their own copy of showAlert (criterion 5).
 *
 * It decides nothing about what is inside it: the alert, the confirm and whatever Phase 8 adds are callers.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent, ReactElement, ReactNode } from 'react';

const OVERLAY_CLASS = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6';
/*
 * SPA-03: the panel is bounded by the window and scrolls inside it. The app opens at 448 px wide and can be dragged
 * down to MAIN_WINDOW.minHeight, so a dialog sized by its content alone would put its buttons off-screen - with no
 * way to answer it and no way out of it.
 */
const PANEL_CLASS = 'w-80 max-w-full max-h-full overflow-hidden flex flex-col rounded-2xl bg-white p-6 ' +
    'shadow-2xl dark:bg-surface-dark animate-modal-in';
/*
 * The body is what scrolls, and it scrolls invisibly.
 *
 * legacy/styles/common.css:8-15 hid scrollbars for the WHOLE document - `::-webkit-scrollbar { display: none }` and
 * `* { scrollbar-width: none }` - so no overlay in v1.2.1 ever drew one. The cutover deleted that stylesheet
 * (ARCH-05) and replaced it in one place, AppShell's content area, which left every dialog in the app drawing a
 * raw Windows scrollbar down a dark panel. The two arbitrary properties here are the same pair AppShell carries,
 * and tests/tailwind-compat.test.ts now refuses a scroll container anywhere in the renderer without them.
 *
 * max-h-[70vh] is v1.2.1's own bound (legacy/pages/work-history.html:1003). The panel above is max-h-full, and
 * min-h-0 lets this shrink below 70vh when the window is shorter than that - SPA-03's case, where a dialog sized
 * by its content alone puts its own buttons out of reach.
 */
const BODY_CLASS = 'min-h-0 max-h-[70vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

interface ModalProps {
    /** The id of the element naming this dialog, so a screen reader announces it rather than the first button. */
    readonly labelledBy: string;
    /** Escape and a click on the backdrop, which are the same answer as the dismiss button. */
    readonly onDismiss: () => void;
    /** Stays put while the body scrolls under it, as v1.2.1's modal title did. Omitted, everything scrolls. */
    readonly header?: ReactNode;
    readonly children: ReactNode;
}

export default function Modal({ labelledBy, onDismiss, header, children }: ModalProps): ReactElement {
    const panel = useRef<HTMLDivElement>(null);

    /*
     * WR-05: aria-modal="true" tells assistive technology that everything outside this panel is inert, and Tab used
     * to walk straight out of it onto the titlebar's Hide and Quit buttons and the four navigation links - so the
     * attribute was an incorrect statement about the document, which is worse than omitting it. The selector is
     * written out at the call site because a selector hoisted to a constant is refused (SPA-13).
     */
    const focusable = useCallback((): HTMLElement[] => {
        // Written out here, not hoisted: a selector in a constant is refused, because that is how
        // legacy/pages/settings.html:659 would come back (SPA-13). No dot in it, so no class is reached.
        return [...panel.current?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []];
    }, []);

    useEffect(() => {
        // WR-05: focus fell to document.body when the panel unmounted, so cancelling a confirm meant tabbing from
        // the top of the app again. Captured before anything inside takes focus, restored on the way out.
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                onDismiss();
                return;
            }
            if (event.key !== 'Tab') return;
            const stops = focusable();
            const first = stops[0];
            const last = stops[stops.length - 1];
            if (first === undefined || last === undefined) {
                // Nothing to move to, so the only honest answer is to stay where we are.
                event.preventDefault();
                return;
            }
            const here = document.activeElement;
            const leaving = event.shiftKey ? here === first : here === last;
            if (leaving || !(here instanceof Node) || panel.current?.contains(here) !== true) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
        };

        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            opener?.focus();
        };
    }, [onDismiss, focusable]);

    // mousedown, not click: a drag that starts inside the panel and ends on the backdrop is not a dismissal.
    // IN-07: the primary button only - a right-click on the backdrop answered the quit confirm.
    const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
        if (event.button === 0 && event.target === event.currentTarget) {
            onDismiss();
        }
    };

    return (
        <div className={OVERLAY_CLASS} onMouseDown={onBackdrop}>
            <div
                ref={panel}
                role="dialog"
                aria-modal="true"
                aria-labelledby={labelledBy}
                className={PANEL_CLASS}
            >
                {header === undefined ? null : <div className="shrink-0">{header}</div>}
                <div className={BODY_CLASS}>{children}</div>
            </div>
        </div>
    );
}

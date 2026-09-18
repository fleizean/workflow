/*
 * The floating add button, shared by Companies and Work History rather than copied into each (criterion 5).
 *
 * It hangs off a rail that is max-w-app and centred, not off the window: `fixed right-6` pins to the viewport edge,
 * which v1.2.1 got away with because its window was phone-shaped. On a wide window the button drifted to the far
 * right while everything else stayed in the 448 px column. The rail ignores the pointer; the button takes it back.
 */

import type { ReactElement } from 'react';

const RAIL_CLASS = 'pointer-events-none fixed inset-x-0 bottom-28 z-30 mx-auto flex max-w-app justify-end px-6';
const BUTTON_CLASS = 'pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary ' +
    'text-white shadow-xl shadow-primary/30 transition-transform hover:scale-110 active:scale-95';

interface FloatingActionProps {
    readonly label: string;
    readonly onClick: () => void;
}

export default function FloatingAction({ label, onClick }: FloatingActionProps): ReactElement {
    return (
        <div className={RAIL_CLASS}>
            <button type="button" aria-label={label} className={BUTTON_CLASS} onClick={onClick}>
                <span className="material-symbols-outlined text-[28px]">add</span>
            </button>
        </div>
    );
}

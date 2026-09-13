/*
 * The frameless window's titlebar, ported from legacy/renderer/titlebar.js. The window has frame: false, so without
 * this the app cannot be moved, minimised or closed at all.
 *
 * legacy/styles/titlebar.css carried the two rules that make it work - a drag region on the bar and no-drag on the
 * buttons inside it. They are Tailwind arbitrary properties here rather than a second stylesheet (ARCH-05).
 *
 * The v1.2.1 minimize-btn and close-btn marker classes are gone: they existed for querySelector, which is the Y2
 * pattern, and React holds the handler directly.
 */

import type { ReactElement } from 'react';
import iconUrl from '@assets/icon.png';
import { useWindowControls } from '../api/useWindowControls';

const BAR_CLASS =
    'flex items-center justify-between px-4 pt-2 pb-2 select-none [-webkit-app-region:drag] ' +
    'bg-background-light dark:bg-background-dark border-b border-slate-200 dark:border-slate-800';

const BUTTON_BASE =
    'flex items-center justify-center w-8 h-8 rounded-md transition-colors [-webkit-app-region:no-drag] ' +
    'text-slate-500 dark:text-slate-400 border-r border-slate-200 dark:border-slate-800';

const MINIMIZE_CLASS = BUTTON_BASE + ' hover:bg-black/5 dark:hover:bg-white/5';
const CLOSE_CLASS = BUTTON_BASE + ' hover:bg-red-500/10 hover:text-red-500';

export default function TitleBar(): ReactElement {
    const { minimize, close } = useWindowControls();

    return (
        <div className={BAR_CLASS}>
            <div className="flex-1">
                <div className="flex items-center gap-2">
                    <img src={iconUrl} className="w-6 h-6" alt="Workflow" />
                </div>
            </div>
            <div className="flex items-center gap-1">
                <button type="button" aria-label="Minimise the window" className={MINIMIZE_CLASS} onClick={minimize}>
                    <span className="material-symbols-outlined text-[18px]">minimize</span>
                </button>
                <button type="button" aria-label="Close the window" className={CLOSE_CLASS} onClick={close}>
                    <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
            </div>
        </div>
    );
}

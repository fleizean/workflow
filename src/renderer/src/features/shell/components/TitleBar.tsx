/*
 * The frameless window's titlebar, ported from legacy/renderer/titlebar.js. The window has frame: false, so without
 * this the app cannot be moved, hidden or quit at all. legacy/styles/titlebar.css's two rules - a drag region on
 * the bar, no-drag on the buttons - are Tailwind arbitrary properties here rather than a second stylesheet (ARCH-05).
 *
 * Two things are deliberately not v1.2.1's: the trailing border-r, which looked like a divider to nothing, and the
 * close button's hover, which now reads as the destructive action X became (owner decision 2026-09-13).
 */

import type { ReactElement } from 'react';
/*
 * The 64px icon, not the 1024px one. Vite fingerprints whatever is imported here into out/renderer/assets, so
 * importing icon.png shipped a SECOND copy of the same 1.84 MB file beside the one the tray needs - the duplicate
 * PNG Phase 10 criterion 8 names - and decoded a megapixel image to draw it 24 CSS pixels wide.
 */
import iconUrl from '@assets/icon-64.png';
import { useShellControls } from '../api/useShellControls';

const BAR_CLASS =
    'flex items-center justify-between px-4 pt-2 pb-2 select-none [-webkit-app-region:drag] ' +
    'bg-background-light dark:bg-background-dark border-b border-slate-200 dark:border-slate-800';

const BUTTON_BASE =
    'flex items-center justify-center w-8 h-8 rounded-md transition-colors [-webkit-app-region:no-drag] ' +
    'text-slate-500 dark:text-slate-400';

const HIDE_CLASS = BUTTON_BASE +
    ' border-r border-slate-200 dark:border-slate-800 hover:bg-black/5 dark:hover:bg-white/5';
const QUIT_CLASS = BUTTON_BASE + ' hover:bg-red-500 hover:text-white';

export default function TitleBar(): ReactElement {
    const { hide, quit } = useShellControls();

    return (
        <div className={BAR_CLASS}>
            <div className="flex-1">
                <div className="flex items-center gap-2">
                    <img src={iconUrl} className="w-6 h-6" alt="Workflow" />
                </div>
            </div>
            <div className="flex items-center gap-1">
                <button type="button" aria-label="Hide the window" className={HIDE_CLASS} onClick={hide}>
                    <span className="material-symbols-outlined text-[18px]">minimize</span>
                </button>
                <button type="button" aria-label="Quit Workflow" className={QUIT_CLASS} onClick={quit}>
                    <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
            </div>
        </div>
    );
}

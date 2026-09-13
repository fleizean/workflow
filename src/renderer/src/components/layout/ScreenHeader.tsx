/*
 * The header v1.2.1 rebuilt at the top of every page: a back chevron, a centred title, and one slot on the right.
 * Carried over as classes rather than as markup, and written once rather than four times.
 *
 * v1.2.1's header sat outside the scrolling <main>, so it stayed put while the list moved under it. AppShell owns
 * the one scroller here and the route renders inside it, so the same behaviour is `sticky top-0`.
 */

import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router-dom';

const HEADER_CLASS = 'sticky top-0 z-20 shrink-0 flex items-center justify-between px-4 pt-4 pb-4 ' +
    'bg-background-light/95 dark:bg-background-dark/95 backdrop-blur-md transition-colors duration-300';
const BACK_CLASS = 'flex items-center justify-center w-10 h-10 -ml-2 rounded-full text-slate-500 ' +
    'dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors';
const TITLE_CLASS = 'text-2xl font-bold leading-tight tracking-tight flex-1 text-center';

interface ScreenHeaderProps {
    readonly title: string;
    /** Where the chevron goes. v1.2.1's back buttons named a fixed page each; these are the same destinations. */
    readonly backTo: string;
    /** The right-hand slot. Empty keeps the title centred, which is what the bare `w-10` spacer was for. */
    readonly children?: ReactNode;
}

export default function ScreenHeader({ title, backTo, children }: ScreenHeaderProps): ReactElement {
    return (
        <header className={HEADER_CLASS}>
            <Link to={backTo} aria-label="Go back" className={BACK_CLASS}>
                <span className="material-symbols-outlined text-[28px]">chevron_left</span>
            </Link>
            <h1 className={TITLE_CLASS}>{title}</h1>
            {children ?? <div className="w-10" />}
        </header>
    );
}

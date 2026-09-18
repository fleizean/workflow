/*
 * legacy/pages/index.html:303-325: the date button on the left and the Pomodoro toggle on the right, with the
 * hidden "Work Timer" heading between them. Three differences:
 *  - the heading is sr-only rather than `hidden`. `hidden` takes it out of the accessibility tree too, so the one
 *    screen with no visible title had no title at all;
 *  - the toggle's colour comes from a lookup of whole class strings rather than inline styles (ARCH-05, and a
 *    class assembled from a colour name emits no CSS at all - C3);
 *  - it is sticky, because AppShell owns the one scroller now and v1.2.1's header sat outside its page's.
 */

import type { ReactElement } from 'react';
import { localDateParts } from '@shared/utils/date';
import type { LocalDate, TimerMode } from '@shared/types';
import { headerDateLabel } from '../timer-view';

const HEADER_CLASS = 'sticky top-0 z-20 shrink-0 flex items-center justify-between px-6 py-4 ' +
    'bg-background-light/95 dark:bg-background-dark/95 backdrop-blur-md transition-colors duration-300';
const DATE_CLASS = 'text-slate-500 dark:text-slate-400 flex items-center gap-2 hover:bg-slate-200 ' +
    'dark:hover:bg-surface-dark px-3 py-2 rounded-xl transition-colors';
const TOGGLE_CLASS: Record<TimerMode, string> = {
    work: 'flex items-center gap-2 px-3 py-2 rounded-xl transition-all duration-200 hover:bg-slate-200 ' +
        'dark:hover:bg-surface-dark',
    pomodoro: 'flex items-center gap-2 px-3 py-2 rounded-xl transition-all duration-200 bg-red-500/10 ' +
        'hover:bg-red-500/20'
};
// #94a3b8 is slate-400 and #ef4444 is red-500, which is what the two inline styles set.
const TOGGLE_ICON_CLASS: Record<TimerMode, string> = {
    work: 'material-symbols-outlined text-xl text-slate-400',
    pomodoro: 'material-symbols-outlined text-xl text-red-500'
};
const TOGGLE_TEXT_CLASS = 'text-xs font-semibold text-slate-500 dark:text-slate-400';
const MODE_LABEL: Record<TimerMode, string> = { work: 'Normal', pomodoro: 'Pomodoro' };

interface HomeHeaderProps {
    readonly date: LocalDate;
    readonly mode: TimerMode;
    readonly onPickDate: () => void;
    readonly onToggleMode: () => void;
}

export default function HomeHeader({ date, mode, onPickDate, onToggleMode }: HomeHeaderProps): ReactElement {
    const parts = localDateParts(date);

    return (
        <header className={HEADER_CLASS}>
            <button type="button" className={DATE_CLASS} onClick={onPickDate}>
                <span className="material-symbols-outlined text-2xl">calendar_month</span>
                <span className="text-sm font-semibold tracking-wide">
                    {headerDateLabel(parts.month, parts.day)}
                </span>
            </button>

            <h1 className="sr-only">Work Timer</h1>

            <button
                type="button"
                aria-pressed={mode === 'pomodoro'}
                className={TOGGLE_CLASS[mode]}
                onClick={onToggleMode}
            >
                <span className={TOGGLE_ICON_CLASS[mode]}>timer</span>
                <span className={TOGGLE_TEXT_CLASS}>{MODE_LABEL[mode]}</span>
            </button>
        </header>
    );
}

/*
 * PANEL-03/PANEL-04: one labelled bar with its figures and its percentage.
 *
 * Drawn as SVG, for the reason the timer ring is: a bar's length is a number, and ARCH-05 allows neither an inline
 * style nor a class name built by concatenation (SPA-11, C3) - so the length is an SVG geometry ATTRIBUTE, exactly
 * as TimerDial passes strokeDashoffset. preserveAspectRatio="none" makes the 100-unit viewBox the row's own width,
 * so x2 is the percentage directly.
 *
 * The bar carries NO transition, and that is the design rather than an omission. A second is 0.003% of an
 * eight-hour target, so an eased width would be a shimmer that says nothing and pulls the eye once a second for a
 * whole working day. The ring does carry one ([transition:stroke-dashoffset_0.35s]); this does not, deliberately.
 * tests/panel-view.test.ts fails on a transition, duration, ease or animate utility reaching this file.
 */

import type { ReactElement } from 'react';

const ROW = 'flex flex-col gap-1.5';
const HEAD = 'flex items-baseline justify-between gap-2';
const LABEL = 'text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400';
const FIGURES = 'text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200';
const PERCENT = 'text-[10px] font-bold tabular-nums text-slate-500 dark:text-slate-400';
const BAR = 'h-1.5 w-full';
const TRACK = 'text-slate-200 dark:text-surface-dark';

/** Whole class strings, never a built name: a colour appended in the attribute emits no CSS at all (SPA-11, C3). */
export const TODAY_FILL = 'text-primary';
export const WEEK_FILL = 'text-emerald-500';
export const MET_FILL = 'text-emerald-400';

interface ProgressRowProps {
    readonly label: string;
    readonly figures: string;
    readonly percentLabel: string;
    /** 0 to 100. describeProgress clamps it; the viewBox is 100 wide, so it is the x2 of the filled line. */
    readonly barPercent: number;
    readonly fill: string;
}

export default function ProgressRow(props: ProgressRowProps): ReactElement {
    return (
        <div className={ROW}>
            <div className={HEAD}>
                <span className={LABEL}>{props.label}</span>
                <span className={FIGURES}>
                    {props.figures}
                    <span className={PERCENT}>{' · ' + props.percentLabel}</span>
                </span>
            </div>
            <svg aria-hidden="true" className={BAR} preserveAspectRatio="none" viewBox="0 0 100 6">
                <line className={TRACK} stroke="currentColor" strokeWidth="6" x1="0" x2="100" y1="3" y2="3" />
                {/* A zero-length line draws nothing, which is what 0% should look like. */}
                <line
                    className={props.fill}
                    stroke="currentColor"
                    strokeWidth="6"
                    x1="0"
                    x2={props.barPercent}
                    y1="3"
                    y2="3"
                />
            </svg>
        </div>
    );
}

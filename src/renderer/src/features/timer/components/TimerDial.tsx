/*
 * The ring, the digits, the status badge and the meta pill - legacy/pages/index.html:379-430, class for class.
 *
 * It draws a value and decides nothing: the offset, the colour, the digits and the meta line all arrive computed
 * from timer-view.ts, which is the only place any of it can be run by a test.
 *
 * Two carried oddities, both v1.2.1's and both flagged in 08-C-SUMMARY.md rather than quietly corrected:
 *  - the <svg> is rotated -90 AND the progress circle another -90, so the arc starts at nine o'clock;
 *  - the badge stays on screen while paused. v1.2.1 hid it on pause through an inline style; the ping animation
 *    carries the running state here instead.
 */

import type { ReactElement } from 'react';
import type { DialDigits } from '../timer-view';

export type RingColour = 'normal' | 'near' | 'complete' | 'work' | 'break';

const RING_CLASS: Record<RingColour, string> = {
    normal: 'text-primary [transition:stroke-dashoffset_0.35s] -rotate-90 origin-center',
    near: 'text-orange-500 [transition:stroke-dashoffset_0.35s] -rotate-90 origin-center',
    complete: 'text-emerald-500 [transition:stroke-dashoffset_0.35s] -rotate-90 origin-center',
    work: 'text-red-500 [transition:stroke-dashoffset_0.35s] -rotate-90 origin-center',
    break: 'text-emerald-500 [transition:stroke-dashoffset_0.35s] -rotate-90 origin-center'
};

const HEADLINE_CLASS: Record<'normal' | 'exceeded', string> = {
    normal: 'text-slate-400 dark:text-slate-500 text-sm font-bold uppercase tracking-[0.2em] mb-3 mt-5',
    exceeded: 'text-red-400 text-sm font-bold uppercase tracking-[0.2em] mb-3 mt-5'
};

const BADGE_CLASS = 'mt-4 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 flex items-center ' +
    'gap-1.5 backdrop-blur-xs';
const BADGE_TEXT_CLASS = 'text-[10px] font-bold text-primary uppercase tracking-wider';
const BIG_DIGIT_CLASS = 'text-5xl font-bold tracking-tighter tabular-nums';
const LAST_DIGIT_CLASS = 'text-3xl font-bold tracking-tighter tabular-nums text-slate-500 dark:text-slate-400';
const COLON_CLASS = 'text-3xl font-light text-slate-400 dark:text-white/30 -mt-2';
const META_CLASS = 'text-slate-400 dark:text-[#92b7c9] text-sm font-medium mt-6 flex flex-col items-center ' +
    'gap-1 bg-slate-100 dark:bg-surface-dark px-4 py-3 rounded-full';
// legacy/pages/index.html:415 - the pomodoro badge glyph, filled and shadowed.
const PIZZA_CLASS = 'material-symbols-outlined text-[12px] text-red-500 ' +
    "drop-shadow-[0_0_4px_rgba(239,68,68,0.6)] [font-variation-settings:'FILL'_1]";

interface TimerDialProps {
    readonly headline: string;
    readonly exceeded: boolean;
    readonly digits: DialDigits;
    readonly ringOffset: number;
    readonly ringColour: RingColour;
    /** The pomodoro glyph replaces the pinging dot when the cycle is on screen, as v1.2.1's did. */
    readonly badgeIcon: string | null;
    readonly badgeText: string;
    readonly running: boolean;
    readonly meta: string;
}

export default function TimerDial(props: TimerDialProps): ReactElement {
    const [hours, minutes, seconds] = props.digits;

    return (
        <div className="flex-1 flex flex-col items-center justify-center relative min-h-[250px] shrink-0">
            <h2 className={HEADLINE_CLASS[props.exceeded ? 'exceeded' : 'normal']}>{props.headline}</h2>

            <div className="relative w-full max-w-[300px] aspect-square flex items-center justify-center">
                <svg className="absolute w-full h-full -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
                    <circle
                        className="text-slate-200 dark:text-white/5"
                        cx="50"
                        cy="50"
                        fill="none"
                        r="45"
                        stroke="currentColor"
                        strokeWidth="6"
                    />
                    <circle
                        className={RING_CLASS[props.ringColour]}
                        cx="50"
                        cy="50"
                        fill="none"
                        r="45"
                        stroke="currentColor"
                        strokeDasharray="283"
                        strokeDashoffset={props.ringOffset}
                        strokeLinecap="round"
                        strokeWidth="6"
                    />
                </svg>

                <div className="flex flex-col items-center z-10">
                    <div className="flex items-baseline gap-1 text-slate-900 dark:text-white drop-shadow-md">
                        <span className={BIG_DIGIT_CLASS}>{hours}</span>
                        <span className={COLON_CLASS}>:</span>
                        <span className={BIG_DIGIT_CLASS}>{minutes}</span>
                        <span className={COLON_CLASS}>:</span>
                        <span className={LAST_DIGIT_CLASS}>{seconds}</span>
                    </div>

                    <div className={BADGE_CLASS}>
                        {props.badgeIcon === null ? (
                            <span className="relative flex h-1.5 w-1.5">
                                {props.running ? (
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                                ) : null}
                                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
                            </span>
                        ) : (
                            <span className={PIZZA_CLASS}>{props.badgeIcon}</span>
                        )}
                        <span className={BADGE_TEXT_CLASS}>{props.badgeText}</span>
                    </div>
                </div>
            </div>

            <div className={META_CLASS}>
                <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-sm">schedule</span>
                    <span>{props.meta}</span>
                </div>
            </div>
        </div>
    );
}

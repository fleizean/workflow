/*
 * The cycle's controls. Same geometry as the work timer's - legacy/pages/index.html:434-470 - because it is the
 * same row on the same screen. v1.2.1 had no cycle controls beyond the shared play button: skipBreak() existed on
 * the timer class (legacy/renderer/timer.js:189) and nothing ever called it, which is POMO-05.
 */

import type { ReactElement } from 'react';

const SECONDARY_CLASS = 'flex flex-col items-center justify-center w-16 h-16 rounded-2xl bg-slate-200 ' +
    'dark:bg-surface-dark text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-[#233c48] ' +
    'transition-all active:scale-95 group disabled:opacity-40 disabled:hover:scale-100';
const PRIMARY_CLASS = 'flex items-center justify-center w-24 h-24 rounded-full bg-primary text-white ' +
    'transition-all active:scale-95 active:shadow-inner relative overflow-hidden group';
const PRIMARY_WASH = 'absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 ' +
    'transition-transform duration-300 ease-out rounded-full';
const PRIMARY_GLYPH = "material-symbols-outlined text-5xl relative z-10 [font-variation-settings:'FILL'_1]";
const CAPTION_CLASS = 'text-[10px] font-bold uppercase mt-1';
const SKIP_GLYPH = 'material-symbols-outlined text-2xl group-hover:text-emerald-400 transition-colors';
const ABORT_GLYPH = 'material-symbols-outlined text-2xl group-hover:text-red-400 transition-colors';
const COUNTS_CLASS = 'text-center text-xs font-semibold uppercase tracking-wider text-slate-500 ' +
    'dark:text-slate-400';

interface PomodoroControlsProps {
    readonly running: boolean;
    readonly isBreak: boolean;
    /** Nothing to abandon while the cycle sits at the start of an interval. */
    readonly hasProgress: boolean;
    readonly busy: boolean;
    readonly countsLabel: string;
    readonly onToggle: () => void;
    readonly onSkipBreak: () => void;
    readonly onAbort: () => void;
}

export default function PomodoroControls(props: PomodoroControlsProps): ReactElement {
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
                <button
                    type="button"
                    disabled={!props.isBreak}
                    className={SECONDARY_CLASS}
                    onClick={props.onSkipBreak}
                >
                    <span className={SKIP_GLYPH}>skip_next</span>
                    <span className={CAPTION_CLASS}>Skip</span>
                </button>

                <button
                    type="button"
                    aria-label={props.running ? 'Pause the cycle' : 'Start the cycle'}
                    disabled={props.busy}
                    className={PRIMARY_CLASS}
                    onClick={props.onToggle}
                >
                    <div className={PRIMARY_WASH} />
                    <span className={PRIMARY_GLYPH}>{props.running ? 'pause' : 'play_arrow'}</span>
                </button>

                <button
                    type="button"
                    disabled={!props.hasProgress}
                    className={SECONDARY_CLASS}
                    onClick={props.onAbort}
                >
                    <span className={ABORT_GLYPH}>stop_circle</span>
                    <span className={CAPTION_CLASS}>Abandon</span>
                </button>
            </div>

            <p className={COUNTS_CLASS}>{props.countsLabel}</p>
        </div>
    );
}

/*
 * The control panel - legacy/pages/index.html:434-470 - with its three buttons and the full-width reset under them.
 * `shadow-glow` and `hover:bg-primary-dark` are not carried: v1.2.1 wrote both on the play button and its Tailwind
 * config declares neither, so the CDN emitted no CSS for either and neither rendered.
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
const RESET_CLASS = 'w-full py-2.5 rounded-xl bg-slate-200 dark:bg-surface-dark text-slate-600 ' +
    'dark:text-slate-300 hover:bg-red-100 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 ' +
    'transition-all active:scale-95 flex items-center justify-center gap-2 group ' +
    'disabled:opacity-40 disabled:hover:scale-100';
const ADJUST_GLYPH = 'material-symbols-outlined text-2xl group-hover:text-white transition-colors';
const SAVE_GLYPH = 'material-symbols-outlined text-2xl group-hover:text-emerald-400 transition-colors';
const CAPTION_CLASS = 'text-[10px] font-bold uppercase mt-1';

interface TimerControlsProps {
    readonly running: boolean;
    /** Both secondary buttons and the reset are dead while the clock holds nothing, as they were in v1.2.1's flow. */
    readonly hasCountedTime: boolean;
    readonly busy: boolean;
    readonly onAdjust: () => void;
    readonly onToggle: () => void;
    readonly onSave: () => void;
    readonly onReset: () => void;
}

export default function TimerControls(props: TimerControlsProps): ReactElement {
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
                <button
                    type="button"
                    className={SECONDARY_CLASS}
                    onClick={props.onAdjust}
                >
                    <span className={ADJUST_GLYPH}>edit</span>
                    <span className={CAPTION_CLASS}>Adjust</span>
                </button>

                <button
                    type="button"
                    aria-label={props.running ? 'Pause the timer' : 'Start the timer'}
                    disabled={props.busy}
                    className={PRIMARY_CLASS}
                    onClick={props.onToggle}
                >
                    <div className={PRIMARY_WASH} />
                    <span className={PRIMARY_GLYPH}>{props.running ? 'pause' : 'play_arrow'}</span>
                </button>

                <button
                    type="button"
                    disabled={!props.hasCountedTime}
                    className={SECONDARY_CLASS}
                    onClick={props.onSave}
                >
                    <span className={SAVE_GLYPH}>check</span>
                    <span className={CAPTION_CLASS}>Save</span>
                </button>
            </div>

            <button
                type="button"
                disabled={!props.hasCountedTime}
                className={RESET_CLASS}
                onClick={props.onReset}
            >
                <span className="material-symbols-outlined text-lg">restart_alt</span>
                <span className="text-xs font-bold uppercase tracking-wider">Reset Timer</span>
            </button>
        </div>
    );
}

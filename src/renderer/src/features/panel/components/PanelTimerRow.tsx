/*
 * PANEL-02: the elapsed reading, the status, and Start / Pause.
 *
 * There is no Stop. Recording work goes through timer:stopAndSave, which needs a company and a note and refuses an
 * empty note for a company that requires one - so the third button raises the main window with the save form
 * instead of pretending the panel can finish the job (WR-06).
 */

import type { ReactElement } from 'react';

const ROW = 'flex flex-col items-center gap-2 px-4 pt-4';
const ELAPSED = 'text-4xl font-bold leading-none tracking-tight tabular-nums';
const STATUS = 'text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400';
const NOTE = 'text-center text-[11px] leading-snug text-slate-500 dark:text-slate-400';
// The amber Home uses for the same line under its dial.
const ADJUSTED = 'text-center text-[11px] font-semibold leading-snug text-amber-400';
const NOTE_WARNING = 'text-center text-[11px] leading-snug font-semibold text-red-500 dark:text-red-400';
const CONTROLS = 'flex items-center justify-center gap-3 pt-1';
const PRIMARY = 'flex h-12 w-12 items-center justify-center rounded-full bg-primary text-white ' +
    'transition-all active:scale-95 hover:bg-primary/90 disabled:opacity-40 disabled:hover:bg-primary';
const PRIMARY_GLYPH = "material-symbols-outlined text-2xl [font-variation-settings:'FILL'_1]";
const SECONDARY = 'flex items-center gap-1.5 rounded-xl bg-slate-200 px-3 py-2 text-[11px] font-bold uppercase ' +
    'tracking-wider text-slate-600 transition-all active:scale-95 hover:bg-slate-300 dark:bg-surface-dark ' +
    'dark:text-slate-300 dark:hover:bg-[#233c48] disabled:opacity-40 disabled:hover:bg-slate-200 ' +
    'dark:disabled:hover:bg-surface-dark';

interface PanelTimerRowProps {
    readonly elapsed: string;
    readonly status: string;
    readonly running: boolean;
    readonly canToggle: boolean;
    readonly canSave: boolean;
    readonly adjustment: string | null;
    readonly note: string | null;
    readonly warning: boolean;
    readonly busy: boolean;
    readonly onToggle: () => void;
    readonly onSave: () => void;
}

export default function PanelTimerRow(props: PanelTimerRowProps): ReactElement {
    return (
        <div className={ROW}>
            <p className={ELAPSED}>{props.elapsed}</p>
            <p className={STATUS}>{props.status}</p>
            {props.adjustment === null ? null : <p className={ADJUSTED}>{props.adjustment}</p>}
            {props.note === null ? null : (
                <p className={props.warning ? NOTE_WARNING : NOTE}>{props.note}</p>
            )}

            <div className={CONTROLS}>
                <button
                    type="button"
                    aria-label={props.running ? 'Pause the timer' : 'Start the timer'}
                    disabled={props.busy || !props.canToggle}
                    className={PRIMARY}
                    onClick={props.onToggle}
                >
                    <span className={PRIMARY_GLYPH}>{props.running ? 'pause' : 'play_arrow'}</span>
                </button>

                {/* Not a stop: it opens the form in the main window, where a company and a note can be given. */}
                <button
                    type="button"
                    disabled={!props.canSave}
                    className={SECONDARY}
                    onClick={props.onSave}
                >
                    <span className="material-symbols-outlined text-base">check</span>
                    Save
                </button>
            </div>
        </div>
    );
}

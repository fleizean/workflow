/*
 * legacy/pages/index.html:1057-1130's Adjust Time dialog: the six quick buttons, the manual-minutes field and the
 * Close button, field for field.
 *
 * What it adjusts is the one thing that changed, and it matters.
 *
 * v1.2.1's Adjust wrote straight into the elapsed counter (timer.addSeconds -> this.elapsedSeconds += seconds), so
 * a tap added thirty minutes of work that nobody had done, to a clock that then claimed to have counted it. The
 * clock lives in main now and has no channel that adds seconds to it, deliberately: a channel that adds time to the
 * clock is a channel that invents work, and this milestone exists so that time the user did not work is never
 * recorded.
 *
 * So the correction applies to the SESSION about to be written rather than to the clock. It is shown on Home under
 * the dial while it is pending, it is folded into the Save dialog's duration - which is editable, so anything these
 * six buttons cannot reach is still reachable - and it is discarded by Reset, by a save, and by leaving the screen.
 * It is never counted time and it never survives a quit, which means it can only ever lose invented seconds.
 */

import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import Modal from '@renderer/components/ui/Modal';
import { formatElapsed } from '@renderer/lib/duration';
import { adjustmentLabel, savableSeconds } from '../timer-view';

const TITLE_BLOCK_CLASS = 'flex flex-col items-center justify-center text-center pb-2';
const BADGE_CLASS = 'w-14 h-14 rounded-full bg-linear-to-tr/srgb from-blue-900/50 to-primary/20 flex ' +
    'items-center justify-center mb-4 shadow-inner ring-1 ring-white/10';
const TITLE_CLASS = 'text-2xl font-bold text-white tracking-tight';
const LEAD_CLASS = 'text-sm text-gray-400 mt-2 font-medium';
const LABEL_CLASS = 'block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2.5 ml-1';
const ADD_CLASS = 'flex items-center justify-center py-4 px-4 bg-primary/10 hover:bg-primary/20 ' +
    'text-blue-400 font-semibold rounded-2xl active:scale-95 transition-all duration-200 border ' +
    'border-primary/10 group';
const SUBTRACT_CLASS = 'flex items-center justify-center py-4 px-4 bg-white/5 hover:bg-white/10 text-gray-400 ' +
    'hover:text-gray-200 font-semibold rounded-2xl active:scale-95 transition-all duration-200 ' +
    'border border-white/5 group';
const STEP_GLYPH = 'material-symbols-outlined mr-2 text-xl group-hover:scale-110 transition-transform';
const RULE_CLASS = 'h-px bg-linear-to-r/srgb from-transparent via-white/10 to-transparent w-full my-6';
const INPUT_CLASS = 'w-full pl-5 pr-20 py-4 bg-[#27272a] border border-transparent focus:border-primary/50 ' +
    'text-white placeholder-gray-600 rounded-2xl focus:ring-4 focus:ring-primary/10 transition-all ' +
    'outline-hidden text-lg font-medium shadow-inner';
const APPLY_CLASS = 'absolute right-2 top-2 bottom-2 aspect-square bg-linear-to-br/srgb from-blue-500 ' +
    'to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white rounded-xl shadow-lg shadow-blue-500/20 ' +
    'active:scale-90 transition-all duration-300 flex items-center justify-center cursor-pointer';
const CLOSE_CLASS = 'w-full mt-6 py-4 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white font-semibold ' +
    'rounded-2xl active:scale-95 transition-all duration-200 border border-white/5 tracking-wide';
const SUMMARY_CLASS = 'bg-white/5 rounded-2xl p-4 border border-white/10 text-sm mt-6';

const SECONDS_PER_MINUTE = 60;
/** legacy/pages/index.html:1070-1095 - the same six, in the same order. */
const STEPS: readonly { readonly seconds: number; readonly label: string }[] = [
    { seconds: 1800, label: '30 min' },
    { seconds: -1800, label: '30 min' },
    { seconds: 300, label: '5 min' },
    { seconds: -300, label: '5 min' },
    { seconds: 60, label: '1 min' },
    { seconds: -60, label: '1 min' }
];

interface AdjustTimeFormProps {
    readonly elapsedSeconds: number;
    readonly adjustmentSeconds: number;
    readonly onChange: (adjustmentSeconds: number) => void;
    readonly onDismiss: () => void;
}

export default function AdjustTimeForm(props: AdjustTimeFormProps): ReactElement {
    const { adjustmentSeconds, elapsedSeconds, onChange, onDismiss } = props;
    const [minutes, setMinutes] = useState('');
    const titleId = useId();
    const manualId = useId();

    /*
     * Bounded through savableSeconds, so the correction can never take the recorded duration below zero or past a
     * day. v1.2.1 clamped its counter at zero and had no upper bound at all.
     */
    const step = (seconds: number): void => {
        const next = savableSeconds(elapsedSeconds, adjustmentSeconds + seconds) - elapsedSeconds;
        onChange(next);
    };

    const applyManual = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        const typed = Number.parseInt(minutes, 10);
        if (Number.isFinite(typed)) {
            step(typed * SECONDS_PER_MINUTE);
        }
        setMinutes('');
    };

    const pending = adjustmentLabel(adjustmentSeconds);

    return (
        <Modal
            labelledBy={titleId}
            onDismiss={onDismiss}
            header={(
                <div className={TITLE_BLOCK_CLASS}>
                    <div className={BADGE_CLASS}>
                        <span className="material-symbols-outlined text-primary text-3xl">schedule</span>
                    </div>
                    <h2 id={titleId} className={TITLE_CLASS}>Adjust Time</h2>
                    <p className={LEAD_CLASS}>Change the duration this session will be saved with.</p>
                </div>
            )}
        >
            <div className="grid grid-cols-2 gap-3">
                {STEPS.map((quick) => (
                    <button
                        key={String(quick.seconds)}
                        type="button"
                        className={quick.seconds > 0 ? ADD_CLASS : SUBTRACT_CLASS}
                        onClick={() => { step(quick.seconds); }}
                    >
                        <span className={STEP_GLYPH}>{quick.seconds > 0 ? 'add' : 'remove'}</span>
                        {quick.label}
                    </button>
                ))}
            </div>

            <div className={RULE_CLASS} />

            <form onSubmit={applyManual}>
                <label htmlFor={manualId} className={LABEL_CLASS}>Manual Input (Minutes)</label>
                <div className="relative">
                    <input
                        id={manualId}
                        type="number"
                        placeholder="0"
                        className={INPUT_CLASS}
                        value={minutes}
                        onChange={(event) => { setMinutes(event.target.value); }}
                    />
                    <button type="submit" aria-label="Apply the typed minutes" className={APPLY_CLASS}>
                        <span className="material-symbols-outlined text-[1.5rem]">check</span>
                    </button>
                </div>
            </form>

            <div className={SUMMARY_CLASS}>
                <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-gray-400">Counted</span>
                    <span className="font-semibold text-white">{formatElapsed(elapsedSeconds)}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="font-medium text-gray-400">Will be saved as</span>
                    <span className="font-bold text-primary">
                        {formatElapsed(savableSeconds(elapsedSeconds, adjustmentSeconds))}
                    </span>
                </div>
                {pending === null ? null : <p className="mt-2 text-xs text-amber-400">{pending}</p>}
            </div>

            <button type="button" className={CLOSE_CLASS} onClick={onDismiss}>Close</button>
        </Modal>
    );
}

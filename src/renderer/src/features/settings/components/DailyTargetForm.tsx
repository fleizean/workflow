/*
 * The daily-target picker: legacy/pages/settings.html:580-620, which built its markup with innerHTML and read its
 * answer back out of the DOM. The hours box accepts 24 rather than v1.2.1's 23: the service caps the target at
 * 86400 seconds, and a picker that could not express its own cap would make the cap unreachable.
 */

import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import Modal from '@renderer/components/ui/Modal';
import { QUICK_TARGET_HOURS, formatTargetClock, targetSecondsOf } from '../settings-view';

const TITLE_BLOCK_CLASS = 'flex flex-col items-center justify-center text-center pb-2';
const BADGE_CLASS = 'w-14 h-14 rounded-full bg-linear-to-tr/srgb from-blue-900/50 to-primary/20 flex ' +
    'items-center justify-center mb-4 shadow-inner ring-1 ring-white/10';
const TITLE_CLASS = 'text-2xl font-bold text-white tracking-tight';
const LEAD_CLASS = 'text-sm text-gray-400 mt-2 font-medium';
const QUICK_CLASS: Record<'on' | 'off', string> = {
    on: 'flex items-center justify-center py-4 rounded-2xl font-semibold transition-all border active:scale-95 ' +
        'bg-primary/20 text-primary border-primary/50',
    off: 'flex items-center justify-center py-4 rounded-2xl font-semibold transition-all border active:scale-95 ' +
        'bg-white/5 text-gray-300 border-white/5 hover:bg-primary/20 hover:border-primary/50 hover:text-primary'
};
const DIVIDER_CLASS = 'h-px w-full bg-linear-to-r/srgb from-transparent via-white/10 to-transparent';
const GROUP_LABEL_CLASS = 'block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2.5 ml-1';
const SMALL_LABEL_CLASS = 'block text-xs text-gray-500 mb-1.5 ml-1';
const FIELD_CLASS = 'w-full pl-5 pr-5 py-4 bg-[#27272a] border border-transparent focus:border-primary/50 ' +
    'text-white placeholder-gray-600 rounded-2xl focus:ring-4 focus:ring-primary/10 transition-all ' +
    'outline-hidden text-base font-medium shadow-inner';
const APPLY_CLASS = 'w-full mt-3 py-4 bg-linear-to-br/srgb from-emerald-500 to-emerald-600 hover:from-emerald-400 ' +
    'hover:to-emerald-500 text-white font-semibold rounded-2xl active:scale-95 transition-all duration-200 ' +
    'shadow-lg shadow-emerald-500/20';
const CLOSE_CLASS = 'w-full py-4 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white font-semibold ' +
    'rounded-2xl active:scale-95 transition-all duration-200 border border-white/5';

const HOUR = 3600;
const MINUTE = 60;

interface DailyTargetFormProps {
    readonly seconds: number;
    readonly onApply: (seconds: number) => void;
    readonly onDismiss: () => void;
}

export default function DailyTargetForm(props: DailyTargetFormProps): ReactElement {
    const { seconds, onApply, onDismiss } = props;
    const [hours, setHours] = useState(String(Math.floor(seconds / HOUR)));
    const [minutes, setMinutes] = useState(String(Math.floor((seconds % HOUR) / MINUTE)));
    const titleId = useId();
    const hoursId = useId();
    const minutesId = useId();

    const current = formatTargetClock(seconds);

    return (
        <Modal
            labelledBy={titleId}
            onDismiss={onDismiss}
            header={(
                <div className={TITLE_BLOCK_CLASS}>
                    <div className={BADGE_CLASS}>
                        <span className="material-symbols-outlined text-primary text-3xl">flag</span>
                    </div>
                    <h2 id={titleId} className={TITLE_CLASS}>Daily Target</h2>
                    <p className={LEAD_CLASS}>Set your daily work hour goal, up to 24:00.</p>
                </div>
            )}
        >
            <div className="grid grid-cols-2 gap-3 mb-4">
                {QUICK_TARGET_HOURS.map((quick) => (
                    <button
                        key={quick}
                        type="button"
                        className={QUICK_CLASS[formatTargetClock(quick * HOUR) === current ? 'on' : 'off']}
                        onClick={() => { onApply(quick * HOUR); }}
                    >
                        <span className="material-symbols-outlined mr-1.5 text-lg">schedule</span>
                        {String(quick) + 'h'}
                    </button>
                ))}
            </div>

            <div className="px-8 py-6">
                <div className={DIVIDER_CLASS} />
            </div>

            <div className="mb-4">
                <p className={GROUP_LABEL_CLASS}>Custom Time</p>
                <div className="flex gap-3">
                    <div className="flex-1">
                        <label htmlFor={hoursId} className={SMALL_LABEL_CLASS}>Hours</label>
                        <input
                            id={hoursId}
                            type="number"
                            inputMode="numeric"
                            min="0"
                            max="24"
                            className={FIELD_CLASS}
                            value={hours}
                            onChange={(event) => { setHours(event.target.value); }}
                        />
                    </div>
                    <div className="flex-1">
                        <label htmlFor={minutesId} className={SMALL_LABEL_CLASS}>Minutes</label>
                        <input
                            id={minutesId}
                            type="number"
                            inputMode="numeric"
                            min="0"
                            max="59"
                            className={FIELD_CLASS}
                            value={minutes}
                            onChange={(event) => { setMinutes(event.target.value); }}
                        />
                    </div>
                </div>
                <button
                    type="button"
                    className={APPLY_CLASS}
                    onClick={() => { onApply(targetSecondsOf(Number(hours), Number(minutes))); }}
                >
                    Apply Custom
                </button>
            </div>
            <button type="button" className={CLOSE_CLASS} onClick={onDismiss}>Close</button>
        </Modal>
    );
}

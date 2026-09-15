/*
 * One of the four pomodoro number cards (legacy/pages/settings.html:160-234), which were four copies of one card.
 *
 * The input's min and max are the bounds MAIN enforces, not v1.2.1's - it wrote min=1 max=60 on work duration,
 * min=5 on the long break and min=2 on the cycle, none of which the service has ever refused on. A field that
 * disagrees with the validator either blocks a legal value or promises an illegal one.
 */

import { useId } from 'react';
import type { ReactElement } from 'react';
import { boundOf } from '../settings-view';
import type { NumberField } from '../settings-view';

const CARD_CLASS = 'bg-white dark:bg-surface-dark rounded-2xl p-4 shadow-xs border border-black/5 ' +
    'dark:border-white/5';
const HEAD_CLASS = 'flex justify-between items-center mb-2';
const LABEL_CLASS = 'text-slate-900 dark:text-white text-sm font-medium';
const VALUE_CLASS = 'text-xs text-slate-500 dark:text-slate-400 font-semibold';
const INPUT_CLASS = 'block w-full rounded-xl border-none bg-slate-100 dark:bg-[#233c48] text-slate-900 ' +
    'dark:text-white focus:ring-2 focus:ring-primary/50 h-12 px-4 text-base font-medium shadow-inner';
const HINT_CLASS = 'text-slate-500 dark:text-[#92b7c9] text-xs mt-2 pl-1';
const ERROR_CLASS = 'text-red-600 dark:text-red-400 text-xs mt-2 pl-1';

interface NumberSettingCardProps {
    readonly field: NumberField;
    /** What is in the box, as typed: an empty box is not a zero. */
    readonly value: string;
    readonly error?: string;
    readonly onChange: (next: string) => void;
}

export default function NumberSettingCard(props: NumberSettingCardProps): ReactElement {
    const { field, value, error, onChange } = props;
    const inputId = useId();
    const messageId = useId();
    const bound = boundOf(field);
    const suffix = field.unit === 'minutes' ? ' min' : '';

    return (
        <div className={CARD_CLASS}>
            <div className={HEAD_CLASS}>
                <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-lg">{field.icon}</span>
                    <label htmlFor={inputId} className={LABEL_CLASS}>{field.label}</label>
                </div>
                <span className={VALUE_CLASS}>{value + suffix}</span>
            </div>
            <input
                id={inputId}
                type="number"
                inputMode="numeric"
                min={bound.min}
                max={bound.max}
                value={value}
                aria-invalid={error !== undefined}
                aria-describedby={messageId}
                className={INPUT_CLASS}
                onChange={(event) => { onChange(event.target.value); }}
            />
            <p id={messageId} className={error === undefined ? HINT_CLASS : ERROR_CLASS}>
                {error ?? field.hint}
            </p>
        </div>
    );
}

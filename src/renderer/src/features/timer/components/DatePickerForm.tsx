/*
 * legacy/pages/index.html:1293-1358's Select Date dialog: four quick dates, a custom date field and Close.
 *
 * v1.2.1 filled its custom field with `currentDate.toISOString().split('T')[0]` (:1341) - B9. West of Greenwich
 * that names YESTERDAY for every date picked before the zone offset, so the field opened on the wrong day and a
 * user who then pressed Enter changed the date without meaning to. The day is a LocalDate here and never goes
 * through UTC (SHARED-03).
 *
 * What the picked day is FOR is the other half, and it is TIMER-04: v1.2.1 used it to re-read the Logged card and
 * then saved with today's date regardless (:1229). Here it is the date the save dialog opens on.
 */

import { useId } from 'react';
import type { ReactElement } from 'react';
import Modal from '@renderer/components/ui/Modal';
import { formatLongDay } from '@renderer/lib/format';
import { addDays } from '@shared/utils/date';
import type { LocalDate } from '@shared/types';

const TITLE_BLOCK_CLASS = 'flex flex-col items-center justify-center text-center pb-2';
const BADGE_CLASS = 'w-14 h-14 rounded-full bg-linear-to-tr/srgb from-blue-900/50 to-primary/20 flex ' +
    'items-center justify-center mb-4 shadow-inner ring-1 ring-white/10';
const TITLE_CLASS = 'text-2xl font-bold text-white tracking-tight';
const LEAD_CLASS = 'text-sm text-gray-400 mt-2 font-medium';
const LABEL_CLASS = 'block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2.5 ml-1';
const QUICK_CLASS: Record<'on' | 'off', string> = {
    on: 'flex items-center justify-center gap-2 py-4 bg-linear-to-br/srgb from-blue-500 to-blue-600 text-white ' +
        'shadow-lg shadow-blue-500/20 font-semibold rounded-2xl active:scale-95 transition-all duration-200',
    off: 'flex items-center justify-center gap-2 py-4 bg-white/5 hover:bg-white/10 text-gray-300 ' +
        'hover:text-white border border-white/5 font-semibold rounded-2xl active:scale-95 transition-all ' +
        'duration-200'
};
const RULE_CLASS = 'h-px bg-linear-to-r/srgb from-transparent via-white/10 to-transparent w-full my-4';
const DATE_CLASS = 'w-full pl-14 pr-5 py-4 bg-[#27272a] border border-transparent focus:border-primary/50 ' +
    'text-white rounded-2xl focus:ring-4 focus:ring-primary/10 transition-all outline-hidden text-base ' +
    'font-medium shadow-inner cursor-pointer [color-scheme:dark]';
const CLOSE_CLASS = 'w-full mt-6 py-4 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white font-semibold ' +
    'rounded-2xl active:scale-95 transition-all duration-200 border border-white/5 tracking-wide';

const QUICK_DATES: readonly { readonly offset: number; readonly icon: string; readonly label: string }[] = [
    { offset: 0, icon: 'today', label: 'Today' },
    { offset: -1, icon: 'history', label: 'Yesterday' },
    { offset: -2, icon: 'event', label: '2 Days Ago' },
    { offset: -3, icon: 'event', label: '3 Days Ago' }
];

interface DatePickerFormProps {
    readonly date: LocalDate;
    readonly today: LocalDate;
    readonly onPick: (date: LocalDate) => void;
    readonly onDismiss: () => void;
}

export default function DatePickerForm({ date, today, onPick, onDismiss }: DatePickerFormProps): ReactElement {
    const titleId = useId();
    const customId = useId();

    return (
        <Modal
            labelledBy={titleId}
            onDismiss={onDismiss}
            header={(
                <div className={TITLE_BLOCK_CLASS}>
                    <div className={BADGE_CLASS}>
                        <span className="material-symbols-outlined text-primary text-3xl">calendar_month</span>
                    </div>
                    <h2 id={titleId} className={TITLE_CLASS}>Select Date</h2>
                    <p className={LEAD_CLASS}>Choose the day this session belongs to.</p>
                </div>
            )}
        >
            <label className={LABEL_CLASS}>Quick Select</label>
            <div className="grid grid-cols-2 gap-3">
                {QUICK_DATES.map((quick) => {
                    const target = addDays(today, quick.offset);
                    return (
                        <button
                            key={quick.label}
                            type="button"
                            className={QUICK_CLASS[target === date ? 'on' : 'off']}
                            onClick={() => { onPick(target); }}
                        >
                            <span className="material-symbols-outlined text-lg">{quick.icon}</span>
                            {quick.label}
                        </button>
                    );
                })}
            </div>

            <div className={RULE_CLASS} />

            <label htmlFor={customId} className={LABEL_CLASS}>Custom Date</label>
            <div className="relative">
                <div className="absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none">
                    <span className="material-symbols-outlined text-primary text-xl">edit_calendar</span>
                </div>
                <input
                    id={customId}
                    type="date"
                    className={DATE_CLASS}
                    value={date}
                    onChange={(event) => {
                        const picked = event.target.value;
                        if (picked !== '') {
                            onPick(picked as LocalDate);
                        }
                    }}
                />
            </div>
            <p className="text-xs text-gray-500 mt-1.5 ml-1">{formatLongDay(date)}</p>

            <button type="button" className={CLOSE_CLASS} onClick={onDismiss}>Close</button>
        </Modal>
    );
}

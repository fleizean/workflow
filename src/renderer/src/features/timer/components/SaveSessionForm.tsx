/*
 * TIMER-02/03/04. legacy/pages/index.html:1152-1206's Save Work Session dialog: the name field, the company select
 * with its business glyph and chevron, the duration/date summary, the note field and the two buttons.
 *
 * Four differences from v1.2.1, each a defect it shipped:
 *
 *  - TIMER-03 (B11). v1.2.1 rejected an empty note from EVERY company (`if (!note) showAlert(...)`, :1218), so the
 *    note-required flag it stored was ignored on this screen in both directions: companies that did not require one
 *    demanded it anyway. The flag decides it here, and the service refuses it again below IPC whatever a screen says.
 *  - TIMER-04 (B10). v1.2.1's header date picker changed which day the Logged card measured and then saved with
 *    `date: getCurrentDate()` (:1229) - today, always. A session picked as Yesterday was written to today. The date
 *    the screen is showing is the date that is written, and it is on the form where it can be seen and changed.
 *  - the company select carries "No Company". v1.2.1's held companies only and read it back with parseInt, so with
 *    no companies at all it wrote NaN into the row.
 *  - the duration is editable. v1.2.1 showed it as text. It is the same field History's form has, and it is the
 *    answer for a timer left running across a weekend, which counts past the one-day bound the contract enforces.
 */

import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import Modal from '@renderer/components/ui/Modal';
import { formatLongDay } from '@renderer/lib/format';
import { formatElapsed } from '@renderer/lib/duration';
import { addDays } from '@shared/utils/date';
import type { Company, LocalDate } from '@shared/types';
import type { StopAndSaveValues } from '../api/useTimerCommands';

const TITLE_BLOCK_CLASS = 'flex flex-col items-center justify-center text-center pb-2';
const BADGE_CLASS = 'w-14 h-14 rounded-full bg-linear-to-tr/srgb from-blue-900/50 to-primary/20 flex ' +
    'items-center justify-center mb-4 shadow-inner ring-1 ring-white/10';
const TITLE_CLASS = 'text-2xl font-bold text-white tracking-tight';
const LEAD_CLASS = 'text-sm text-gray-400 mt-2 font-medium';
const LABEL_CLASS = 'block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2.5 ml-1';
const FIELD_CLASS = 'w-full pl-5 pr-5 py-4 bg-[#27272a] border border-transparent focus:border-primary/50 ' +
    'text-white placeholder-gray-600 rounded-2xl focus:ring-4 focus:ring-primary/10 transition-all ' +
    'outline-hidden text-base font-medium shadow-inner';
const SELECT_CLASS = 'w-full pl-14 pr-12 py-4 bg-[#27272a] border border-transparent focus:border-primary/50 ' +
    'text-white rounded-2xl focus:ring-4 focus:ring-primary/10 transition-all outline-hidden text-base ' +
    'font-medium shadow-inner appearance-none cursor-pointer';
const DATE_CLASS = FIELD_CLASS + ' [color-scheme:dark]';
const NOTE_CLASS = FIELD_CLASS + ' resize-none';
const SUMMARY_CLASS = 'bg-white/5 rounded-2xl p-4 border border-white/10';
const SUBMIT_CLASS = 'w-full py-4 mt-2 bg-linear-to-br/srgb from-blue-500 to-blue-600 hover:from-blue-400 ' +
    'hover:to-blue-500 text-white font-semibold rounded-2xl active:scale-95 transition-all duration-200 ' +
    'shadow-lg shadow-blue-500/20 disabled:opacity-50';
const CANCEL_CLASS = 'w-full py-4 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white font-semibold ' +
    'rounded-2xl active:scale-95 transition-all duration-200 border border-white/5';
const QUICK_CLASS: Record<'on' | 'off', string> = {
    on: 'flex flex-col items-center justify-center gap-1 py-3 rounded-2xl font-semibold active:scale-95 ' +
        'transition-all duration-200 bg-linear-to-br/srgb from-blue-500 to-blue-600 text-white shadow-lg ' +
        'shadow-blue-500/20',
    off: 'flex flex-col items-center justify-center gap-1 py-3 rounded-2xl font-semibold active:scale-95 ' +
        'transition-all duration-200 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white ' +
        'border border-white/5'
};

const QUICK_DATES: readonly { readonly offset: number; readonly icon: string; readonly label: string }[] = [
    { offset: 0, icon: 'today', label: 'Today' },
    { offset: -1, icon: 'history', label: 'Yesterday' },
    { offset: -2, icon: 'event', label: '2 Days Ago' }
];

const NO_COMPANY = '';
const SECONDS_PER_HOUR = 3600;
/** v1.2.1's default name, which it also pre-filled and selected (legacy/pages/index.html:1157). */
export const DEFAULT_SESSION_NAME = 'Work Session';

interface SaveSessionFormProps {
    readonly countedSeconds: number;
    readonly date: LocalDate;
    readonly today: LocalDate;
    readonly companies: readonly Company[];
    readonly busy: boolean;
    readonly onSubmit: (values: StopAndSaveValues) => void;
    /** A refusal is the caller's to report; this only decides what is wrong (History's form does the same). */
    readonly onInvalid: (reason: string) => void;
    readonly onDismiss: () => void;
}

export default function SaveSessionForm(props: SaveSessionFormProps): ReactElement {
    const { busy, companies, countedSeconds, onDismiss, onInvalid, onSubmit, today } = props;
    const [name, setName] = useState(DEFAULT_SESSION_NAME);
    const [companyId, setCompanyId] = useState<number | null>(companies[0]?.id ?? null);
    const [hours, setHours] = useState((countedSeconds / SECONDS_PER_HOUR).toFixed(2));
    const [date, setDate] = useState<LocalDate>(props.date);
    const [note, setNote] = useState('');
    const titleId = useId();
    const nameId = useId();
    const companyFieldId = useId();
    const hoursId = useId();
    const dateId = useId();
    const noteId = useId();

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        const durationSeconds = Math.floor((Number.parseFloat(hours) || 0) * SECONDS_PER_HOUR);
        if (durationSeconds <= 0) {
            onInvalid('There is no time to save');
            return;
        }
        const trimmedNote = note.trim();
        const company = companies.find((row) => row.id === companyId);
        // TIMER-03: this company's own answer, not "every company" as v1.2.1 asked it.
        if (company !== undefined && company.noteRequired && trimmedNote === '') {
            onInvalid(company.name + ' requires a note on every session');
            return;
        }
        onSubmit({
            name: name.trim() === '' ? DEFAULT_SESSION_NAME : name.trim(),
            durationSeconds,
            date,
            companyId,
            note: trimmedNote === '' ? null : trimmedNote
        });
    };

    const selected = companies.find((row) => row.id === companyId);

    return (
        <Modal
            labelledBy={titleId}
            onDismiss={onDismiss}
            header={(
                <div className={TITLE_BLOCK_CLASS}>
                    <div className={BADGE_CLASS}>
                        <span className="material-symbols-outlined text-primary text-3xl">save</span>
                    </div>
                    <h2 id={titleId} className={TITLE_CLASS}>Save Work Session</h2>
                    <p className={LEAD_CLASS}>Save your progress to work history.</p>
                </div>
            )}
        >
            <form onSubmit={submit} className="flex flex-col gap-4">
                <div>
                    <label htmlFor={nameId} className={LABEL_CLASS}>Session Name</label>
                    <input
                        id={nameId}
                        type="text"
                        autoFocus
                        placeholder={DEFAULT_SESSION_NAME}
                        className={FIELD_CLASS}
                        value={name}
                        onChange={(event) => { setName(event.target.value); }}
                    />
                </div>

                <div>
                    <label htmlFor={companyFieldId} className={LABEL_CLASS}>Company</label>
                    <div className="relative">
                        <div className="absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none">
                            <span className="material-symbols-outlined text-primary text-xl">business</span>
                        </div>
                        <select
                            id={companyFieldId}
                            className={SELECT_CLASS}
                            value={companyId === null ? NO_COMPANY : String(companyId)}
                            onChange={(event) => {
                                setCompanyId(event.target.value === NO_COMPANY ? null : Number(event.target.value));
                            }}
                        >
                            <option value={NO_COMPANY}>No Company</option>
                            {companies.map((company) => (
                                <option key={company.id} value={String(company.id)}>{company.name}</option>
                            ))}
                        </select>
                        <div className="absolute right-5 top-1/2 -translate-y-1/2 pointer-events-none">
                            <span className="material-symbols-outlined text-gray-400 text-xl">expand_more</span>
                        </div>
                    </div>
                </div>

                <div className={SUMMARY_CLASS}>
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-400">Counted</span>
                        <span className="text-lg font-bold text-primary">{formatElapsed(countedSeconds)}</span>
                    </div>
                </div>

                <div>
                    <label htmlFor={hoursId} className={LABEL_CLASS}>Duration (hours)</label>
                    <input
                        id={hoursId}
                        type="number"
                        min="0"
                        step="0.25"
                        className={FIELD_CLASS}
                        value={hours}
                        onChange={(event) => { setHours(event.target.value); }}
                    />
                </div>

                <div>
                    <label htmlFor={dateId} className={LABEL_CLASS}>Date</label>
                    <div className="grid grid-cols-3 gap-3 mb-3">
                        {QUICK_DATES.map((quick) => {
                            const target = addDays(today, quick.offset);
                            return (
                                <button
                                    key={quick.label}
                                    type="button"
                                    className={QUICK_CLASS[target === date ? 'on' : 'off']}
                                    onClick={() => { setDate(target); }}
                                >
                                    <span className="material-symbols-outlined text-lg">{quick.icon}</span>
                                    <span className="text-xs">{quick.label}</span>
                                </button>
                            );
                        })}
                    </div>
                    <input
                        id={dateId}
                        type="date"
                        required
                        className={DATE_CLASS}
                        value={date}
                        onChange={(event) => {
                            const picked = event.target.value;
                            if (picked !== '') {
                                setDate(picked as LocalDate);
                            }
                        }}
                    />
                    <p className="text-xs text-gray-500 mt-1.5 ml-1">{formatLongDay(date)}</p>
                </div>

                <div>
                    <label htmlFor={noteId} className={LABEL_CLASS}>
                        Note{selected?.noteRequired === true ? <span className="text-red-400"> *</span> : ' (Optional)'}
                    </label>
                    <textarea
                        id={noteId}
                        rows={3}
                        placeholder="Add a note about this session..."
                        className={NOTE_CLASS}
                        value={note}
                        onChange={(event) => { setNote(event.target.value); }}
                    />
                </div>

                <button type="submit" disabled={busy} className={SUBMIT_CLASS}>Save Session</button>
                <button type="button" className={CANCEL_CLASS} onClick={onDismiss}>Cancel</button>
            </form>
        </Modal>
    );
}

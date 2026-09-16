/*
 * Add and edit a work session: legacy/pages/work-history.html:348-393 and :1162-1199, which were two copies of one
 * form with different button text.
 *
 * Four differences from v1.2.1, each deliberate:
 *  - it is drawn inside components/ui/Modal, like every other overlay in the app (criterion 5);
 *  - note-required is honoured here too. v1.2.1 checked it on the ADD form only, so editing a session belonging to
 *    a company that requires a note could clear the note;
 *  - the company list carries "No Company". v1.2.1's select held companies only and read it back with
 *    parseInt(value), so a session attributed to nothing could not be edited without silently acquiring a company -
 *    and an empty list wrote NaN;
 *  - the quick dates are three buttons in this form rather than a second modal on top of the first. The nested
 *    date-picker overlay is not carried.
 *
 * BL-01/BL-02: the duration is whole hours and whole minutes over an integer second count. It used to be a
 * one-decimal hours string, so saving THIS FORM rewrote the duration of a session whose note was the only thing
 * touched (4980 s -> 5040 s), and its step="0.5" inside a real <form> refused the submit for every duration that
 * was not a multiple of thirty minutes. A pair of boxes nobody typed into now writes the stored seconds back
 * byte-identical, and every attribute below states a bound this file actually enforces.
 */

import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import Modal from '@renderer/components/ui/Modal';
import { formatLongDay } from '@renderer/lib/format';
import { MAX_DURATION_HOURS, MINUTES_PER_HOUR, reviewDuration } from '@renderer/lib/duration';
import type { DurationFields, SeededDuration } from '@renderer/lib/duration';
import { addDays } from '@shared/utils/date';
import type { Company, LocalDate } from '@shared/types';
import type { SessionValues } from '../api/useSessionMutations';

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

const WORDING: Record<'create' | 'edit', { icon: string; title: string; lead: string; submit: string }> = {
    create: {
        icon: 'add_circle',
        title: 'Add Work Session',
        lead: 'Create a new work session entry.',
        submit: 'Save Session'
    },
    edit: {
        icon: 'edit',
        title: 'Edit Work Session',
        lead: 'Update session details below.',
        submit: 'Save Changes'
    }
};

const QUICK_DATES: readonly { readonly offset: number; readonly icon: string; readonly label: string }[] = [
    { offset: 0, icon: 'today', label: 'Today' },
    { offset: -1, icon: 'history', label: 'Yesterday' },
    { offset: -2, icon: 'event', label: '2 Days Ago' }
];

const NO_COMPANY = '';
const LAST_MINUTE = MINUTES_PER_HOUR - 1;
const UNIT_CLASS = 'text-xs text-gray-500 mt-1.5 ml-1';

export interface SessionDraft {
    readonly name: string;
    /** The stored seconds and the boxes they seeded: an untouched pair is what writes them back unchanged. */
    readonly duration: SeededDuration;
    readonly date: LocalDate;
    readonly companyId: number | null;
    readonly note: string;
}

interface SessionFormProps {
    readonly mode: 'create' | 'edit';
    readonly initial: SessionDraft;
    readonly companies: readonly Company[];
    readonly today: LocalDate;
    readonly busy: boolean;
    /** Refusals are reported by the caller, which owns the toast queue; this only decides what is wrong. */
    readonly onSubmit: (values: SessionValues) => void;
    readonly onInvalid: (reason: string) => void;
    readonly onDismiss: () => void;
}

export default function SessionForm(props: SessionFormProps): ReactElement {
    const { mode, initial, companies, today, busy, onSubmit, onInvalid, onDismiss } = props;
    const [name, setName] = useState(initial.name);
    const [fields, setFields] = useState<DurationFields>(initial.duration.fields);
    const [date, setDate] = useState<LocalDate>(initial.date);
    const [companyId, setCompanyId] = useState<number | null>(initial.companyId);
    const [note, setNote] = useState(initial.note);
    const titleId = useId();
    const nameId = useId();
    const companySelectId = useId();
    const hoursId = useId();
    const minutesId = useId();
    const dateId = useId();
    const noteId = useId();
    const words = WORDING[mode];

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        const duration = reviewDuration(fields, initial.duration);
        if (duration.seconds === null) {
            onInvalid(duration.refusal ?? 'Enter how long this session was.');
            return;
        }
        const durationSeconds = duration.seconds;
        const trimmedNote = note.trim();
        const company = companies.find((row) => row.id === companyId);
        // HIST-06: on the edit form too, which is where v1.2.1 stopped asking.
        if (company !== undefined && company.noteRequired && trimmedNote === '') {
            onInvalid(company.name + ' requires a note for work sessions');
            return;
        }
        onSubmit({
            name: name.trim() === '' ? 'Work Session' : name.trim(),
            durationSeconds,
            date,
            companyId,
            note: trimmedNote === '' ? null : trimmedNote
        });
    };

    return (
        <Modal
            labelledBy={titleId}
            onDismiss={onDismiss}
            header={(
                <div className={TITLE_BLOCK_CLASS}>
                    <div className={BADGE_CLASS}>
                        <span className="material-symbols-outlined text-primary text-3xl">{words.icon}</span>
                    </div>
                    <h2 id={titleId} className={TITLE_CLASS}>{words.title}</h2>
                    <p className={LEAD_CLASS}>{words.lead}</p>
                </div>
            )}
        >
            {/*
              * noValidate (BL-02): with native validation on, step="0.5" made Chromium refuse the submit for every
              * duration this app writes, so onSubmit never ran and the only way forward was one of the two values
              * the browser offered. The attributes above state the bounds; reviewDuration is what enforces them,
              * and sessions.service.ts refuses again below IPC.
              */}
            <form onSubmit={submit} noValidate className="flex flex-col gap-4">
                <div>
                    <label htmlFor={nameId} className={LABEL_CLASS}>Session Name</label>
                    <input
                        id={nameId}
                        type="text"
                        placeholder="Work Session"
                        className={FIELD_CLASS}
                        value={name}
                        onChange={(event) => { setName(event.target.value); }}
                    />
                </div>
                <div>
                    <label htmlFor={companySelectId} className={LABEL_CLASS}>Company</label>
                    <div className="relative">
                        <div className="absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none">
                            <span className="material-symbols-outlined text-primary text-xl">business</span>
                        </div>
                        <select
                            id={companySelectId}
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
                <div>
                    <span className={LABEL_CLASS}>Duration</span>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <input
                                id={hoursId}
                                type="number"
                                inputMode="numeric"
                                min="0"
                                max={String(MAX_DURATION_HOURS)}
                                step="1"
                                aria-label="Hours"
                                className={FIELD_CLASS}
                                value={fields.hours}
                                onChange={(event) => { setFields({ ...fields, hours: event.target.value }); }}
                            />
                            <p className={UNIT_CLASS}>Hours</p>
                        </div>
                        <div>
                            <input
                                id={minutesId}
                                type="number"
                                inputMode="numeric"
                                min="0"
                                max={String(LAST_MINUTE)}
                                step="1"
                                aria-label="Minutes"
                                className={FIELD_CLASS}
                                value={fields.minutes}
                                onChange={(event) => { setFields({ ...fields, minutes: event.target.value }); }}
                            />
                            <p className={UNIT_CLASS}>Minutes</p>
                        </div>
                    </div>
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
                    <label htmlFor={noteId} className={LABEL_CLASS}>Note (Optional)</label>
                    <textarea
                        id={noteId}
                        rows={3}
                        placeholder="Add a note..."
                        className={NOTE_CLASS}
                        value={note}
                        onChange={(event) => { setNote(event.target.value); }}
                    />
                </div>
                <button type="submit" disabled={busy} className={SUBMIT_CLASS}>{words.submit}</button>
                <button type="button" className={CANCEL_CLASS} onClick={onDismiss}>Cancel</button>
            </form>
        </Modal>
    );
}

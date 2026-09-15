/*
 * POMO-02: which company that pomodoro was for.
 *
 * The thing to understand about this dialog is that it cannot lose anything. By the time it opens, the completed
 * interval is already a work session AND a pomodoro_sessions row, written in one transaction by the composition
 * root before the completion callback returned (container.ts recordCompletion). So this is an edit to a row that
 * exists, and every way out of it - Escape, the backdrop, Not now, closing the window, killing the process - leaves
 * that row exactly as the transaction wrote it, still counted, still in the day's total, and still waiting to be
 * asked about on the next launch.
 *
 * The only button that writes is Save, and what it writes is an ordinary sessions:update - so a company that
 * requires a note refuses it below IPC, exactly as it would on any other screen (COMP-04).
 */

import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import Modal from '@renderer/components/ui/Modal';
import { formatElapsed } from '@renderer/lib/duration';
import { formatLongDay } from '@renderer/lib/format';
import type { Company, WorkSession } from '@shared/types';
import { attributionNote } from '../pomodoro-view';

const TITLE_BLOCK_CLASS = 'flex flex-col items-center justify-center text-center pb-2';
const BADGE_CLASS = 'w-14 h-14 rounded-full bg-linear-to-tr/srgb from-red-900/50 to-red-500/20 flex ' +
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
const NOTE_CLASS = FIELD_CLASS + ' resize-none';
const SUMMARY_CLASS = 'bg-white/5 rounded-2xl p-4 border border-white/10';
const SAFE_CLASS = 'rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs ' +
    'text-emerald-200 flex items-start gap-2';
const SUBMIT_CLASS = 'w-full py-4 mt-2 bg-linear-to-br/srgb from-blue-500 to-blue-600 hover:from-blue-400 ' +
    'hover:to-blue-500 text-white font-semibold rounded-2xl active:scale-95 transition-all duration-200 ' +
    'shadow-lg shadow-blue-500/20 disabled:opacity-50';
const LATER_CLASS = 'w-full py-4 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white font-semibold ' +
    'rounded-2xl active:scale-95 transition-all duration-200 border border-white/5';

const NO_COMPANY = '';

export interface AttributionAnswer {
    readonly companyId: number | null;
    readonly note: string;
}

interface AttributionFormProps {
    readonly session: WorkSession;
    /** How many are waiting behind this one, so a queue of them does not feel endless. */
    readonly remaining: number;
    readonly companies: readonly Company[];
    readonly busy: boolean;
    readonly onSubmit: (answer: AttributionAnswer) => void;
    readonly onInvalid: (reason: string) => void;
    readonly onLater: () => void;
}

export default function AttributionForm(props: AttributionFormProps): ReactElement {
    const { busy, companies, onInvalid, onLater, onSubmit, remaining, session } = props;
    const [companyId, setCompanyId] = useState<number | null>(companies[0]?.id ?? null);
    const [note, setNote] = useState('');
    const titleId = useId();
    const companyFieldId = useId();
    const noteId = useId();

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        const typed = attributionNote(note);
        const company = companies.find((row) => row.id === companyId);
        if (company !== undefined && company.noteRequired && typed === '') {
            onInvalid(company.name + ' requires a note on every session');
            return;
        }
        onSubmit({ companyId, note: typed });
    };

    const selected = companies.find((row) => row.id === companyId);

    return (
        <Modal
            labelledBy={titleId}
            onDismiss={onLater}
            header={(
                <div className={TITLE_BLOCK_CLASS}>
                    <div className={BADGE_CLASS}>
                        <span className="material-symbols-outlined text-red-400 text-3xl">local_pizza</span>
                    </div>
                    <h2 id={titleId} className={TITLE_CLASS}>Who was that pomodoro for?</h2>
                    <p className={LEAD_CLASS}>
                        {remaining > 0
                            ? 'This one, and ' + String(remaining) + ' more waiting behind it.'
                            : 'The interval is already recorded. This only says what it was for.'}
                    </p>
                </div>
            )}
        >
            <form onSubmit={submit} className="flex flex-col gap-4">
                <div className={SUMMARY_CLASS}>
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-gray-400">Recorded</span>
                        <span className="text-lg font-bold text-primary">
                            {formatElapsed(session.durationSeconds)}
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-400">Date</span>
                        <span className="text-sm font-semibold text-white">{formatLongDay(session.date)}</span>
                    </div>
                </div>

                <p className={SAFE_CLASS}>
                    <span className="material-symbols-outlined text-base">check_circle</span>
                    <span>
                        This time is already saved to your work history. Nothing here can remove it - closing this
                        only means you will be asked again.
                    </span>
                </p>

                <div>
                    <label htmlFor={companyFieldId} className={LABEL_CLASS}>Company</label>
                    <div className="relative">
                        <div className="absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none">
                            <span className="material-symbols-outlined text-primary text-xl">business</span>
                        </div>
                        <select
                            id={companyFieldId}
                            autoFocus
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
                    <label htmlFor={noteId} className={LABEL_CLASS}>
                        Note{selected?.noteRequired === true ? <span className="text-red-400"> *</span> : ' (Optional)'}
                    </label>
                    <textarea
                        id={noteId}
                        rows={3}
                        placeholder="What did you work on?"
                        className={NOTE_CLASS}
                        value={note}
                        onChange={(event) => { setNote(event.target.value); }}
                    />
                </div>

                <button type="submit" disabled={busy} className={SUBMIT_CLASS}>Save</button>
                <button type="button" className={LATER_CLASS} onClick={onLater}>Not now - ask me again</button>
            </form>
        </Modal>
    );
}

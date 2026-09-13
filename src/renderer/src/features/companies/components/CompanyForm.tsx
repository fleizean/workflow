/*
 * Add and edit a company: legacy/pages/companies.html:164-197 and :211-262, which were two copies of one form.
 *
 * Three differences from v1.2.1, each deliberate:
 *  - it is drawn inside components/ui/Modal, so the overlay, the escape key, the backdrop click and the focus trap
 *    are the app's one implementation rather than this screen's sixth copy of them (criterion 5);
 *  - the Hours Column and Note Column fields are gone with the Google Sheets export the owner removed, and
 *    migration 0002 dropped the columns behind them;
 *  - it is a <form>, so Enter submits without a keypress listener that only the name input carried.
 */

import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import Modal from '@renderer/components/ui/Modal';
import type { CompanyValues } from '../api/useCompanyMutations';

const TITLE_BLOCK_CLASS = 'flex flex-col items-center justify-center text-center pb-2';
const BADGE_CLASS = 'w-14 h-14 rounded-full bg-linear-to-tr/srgb from-blue-900/50 to-primary/20 flex ' +
    'items-center justify-center mb-4 shadow-inner ring-1 ring-white/10';
const TITLE_CLASS = 'text-2xl font-bold text-white tracking-tight';
const LEAD_CLASS = 'text-sm text-gray-400 mt-2 font-medium';
const LABEL_CLASS = 'block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2.5 ml-1';
const INPUT_CLASS = 'w-full pl-5 pr-5 py-4 bg-[#27272a] border border-transparent focus:border-primary/50 ' +
    'text-white placeholder-gray-600 rounded-2xl focus:ring-4 focus:ring-primary/10 transition-all ' +
    'outline-hidden text-base font-medium shadow-inner';
const CHECK_ROW_CLASS = 'flex items-center gap-3 p-4 rounded-2xl bg-white/5 hover:bg-white/10 cursor-pointer ' +
    'transition-colors border border-white/5';
const CHECKBOX_CLASS = 'w-4 h-4 rounded-sm border-gray-600 text-primary focus:ring-primary/50 focus:ring-2 ' +
    'bg-[#27272a]';
const SUBMIT_CLASS = 'w-full py-4 mb-3 bg-linear-to-br/srgb from-blue-500 to-blue-600 hover:from-blue-400 ' +
    'hover:to-blue-500 text-white font-semibold rounded-2xl active:scale-95 transition-all duration-200 ' +
    'shadow-lg shadow-blue-500/20 disabled:opacity-50';
const CANCEL_CLASS = 'w-full py-4 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white font-semibold ' +
    'rounded-2xl active:scale-95 transition-all duration-200 border border-white/5';

/** Each mode's own wording, written out rather than assembled, so the two forms read as v1.2.1's two forms. */
const WORDING: Record<'create' | 'edit', { icon: string; title: string; lead: string; submit: string }> = {
    create: {
        icon: 'business',
        title: 'Add Company',
        lead: 'Create a new company to organize your work.',
        submit: 'Add Company'
    },
    edit: {
        icon: 'edit',
        title: 'Edit Company',
        lead: 'Update company information.',
        submit: 'Update Company'
    }
};

interface CompanyFormProps {
    readonly mode: 'create' | 'edit';
    readonly initial: CompanyValues;
    readonly busy: boolean;
    readonly onSubmit: (values: CompanyValues) => void;
    readonly onDismiss: () => void;
}

export default function CompanyForm({ mode, initial, busy, onSubmit, onDismiss }: CompanyFormProps): ReactElement {
    const [name, setName] = useState(initial.name);
    const [noteRequired, setNoteRequired] = useState(initial.noteRequired);
    const titleId = useId();
    const nameId = useId();
    const words = WORDING[mode];

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        onSubmit({ name: name.trim(), noteRequired });
    };

    return (
        <Modal labelledBy={titleId} onDismiss={onDismiss}>
            <div className={TITLE_BLOCK_CLASS}>
                <div className={BADGE_CLASS}>
                    <span className="material-symbols-outlined text-primary text-3xl">{words.icon}</span>
                </div>
                <h2 id={titleId} className={TITLE_CLASS}>{words.title}</h2>
                <p className={LEAD_CLASS}>{words.lead}</p>
            </div>
            <form onSubmit={submit}>
                <div className="mb-4">
                    <label htmlFor={nameId} className={LABEL_CLASS}>Company Name</label>
                    <input
                        id={nameId}
                        type="text"
                        autoFocus
                        required
                        placeholder="e.g., NG, DelphisAI"
                        className={INPUT_CLASS}
                        value={name}
                        onChange={(event) => { setName(event.target.value); }}
                    />
                </div>
                <div className="mb-4">
                    <label className={CHECK_ROW_CLASS}>
                        <input
                            type="checkbox"
                            className={CHECKBOX_CLASS}
                            checked={noteRequired}
                            onChange={(event) => { setNoteRequired(event.target.checked); }}
                        />
                        <div className="flex-1">
                            <p className="text-sm text-white font-medium">Require Note</p>
                            <p className="text-xs text-gray-400">Force note when logging work sessions</p>
                        </div>
                    </label>
                </div>
                <button type="submit" disabled={busy} className={SUBMIT_CLASS}>{words.submit}</button>
                <button type="button" className={CANCEL_CLASS} onClick={onDismiss}>Cancel</button>
            </form>
        </Modal>
    );
}

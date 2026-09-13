/*
 * One company. The classes are legacy/pages/companies.html:117-152 carried over unchanged.
 *
 * What is gone is how it was built: v1.2.1 wrote this row with innerHTML and hung the two buttons off
 * onclick="editCompany(1, 'NAME')", escaping exactly one character of the name. A company called
 * <img src=x onerror=alert(1)> ran. Here the name is a JSX child and the handlers are functions, so there is no
 * string for it to be part of (S2).
 *
 * The "Note required" line is the one addition: v1.2.1 let the flag be set and then showed it nowhere, so nobody
 * could tell which companies carried it without opening each one.
 */

import type { ReactElement } from 'react';
import { formatCreatedOn } from '@renderer/lib/format';
import { describeSessionCount } from '../session-counts';
import type { Company } from '@shared/types';

const ROW_CLASS = 'group flex items-center gap-4 rounded-xl bg-white dark:bg-card-dark p-4 mb-3 shadow-sm ' +
    'transition-all hover:shadow-md border border-transparent dark:border-slate-800/50';
const ICON_CLASS = 'flex shrink-0 items-center justify-center rounded-lg bg-primary/10 dark:bg-primary/20 h-14 w-14';
const NAME_CLASS = 'truncate text-base font-semibold text-slate-900 dark:text-white';
const META_CLASS = 'flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400';
const EDIT_CLASS = 'flex items-center justify-center w-9 h-9 rounded-lg bg-blue-500/10 dark:bg-blue-400/10 ' +
    'hover:bg-blue-500/20 dark:hover:bg-blue-400/20 text-blue-600 dark:text-blue-400 transition-colors';
const DELETE_CLASS = 'flex items-center justify-center w-9 h-9 rounded-lg bg-red-500/10 dark:bg-red-400/10 ' +
    'hover:bg-red-500/20 dark:hover:bg-red-400/20 text-red-600 dark:text-red-400 transition-colors';

interface CompanyRowProps {
    readonly company: Company;
    readonly sessionCount: number;
    readonly onEdit: (company: Company) => void;
    readonly onDelete: (company: Company) => void;
}

export default function CompanyRow({ company, sessionCount, onEdit, onDelete }: CompanyRowProps): ReactElement {
    return (
        <div className={ROW_CLASS}>
            <div className={ICON_CLASS}>
                <span className="material-symbols-outlined text-primary text-[28px]">business</span>
            </div>
            <div className="flex flex-1 flex-col justify-center overflow-hidden">
                <p className={NAME_CLASS}>{company.name}</p>
                <div className={META_CLASS}>
                    <span>{describeSessionCount(sessionCount)}</span>
                    <span>&bull;</span>
                    <span>{formatCreatedOn(company.createdAt)}</span>
                    {company.noteRequired ? <span>&bull;</span> : null}
                    {company.noteRequired ? <span>Note required</span> : null}
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <button
                    type="button"
                    aria-label={'Edit ' + company.name}
                    className={EDIT_CLASS}
                    onClick={() => { onEdit(company); }}
                >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                </button>
                <button
                    type="button"
                    aria-label={'Delete ' + company.name}
                    className={DELETE_CLASS}
                    onClick={() => { onDelete(company); }}
                >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                </button>
            </div>
        </div>
    );
}

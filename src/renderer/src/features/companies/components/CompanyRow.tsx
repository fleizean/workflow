/*
 * One company. The classes are legacy/pages/companies.html:117-152 carried over unchanged.
 *
 * What is gone is how it was built: v1.2.1 wrote this row with innerHTML and hung the two buttons off
 * onclick="editCompany(1, 'NAME')", escaping exactly one character of the name, so a company called
 * <img src=x onerror=alert(1)> ran. Here the name is a JSX child and the handlers are functions (S2).
 *
 * The "Note required" line is the one addition: v1.2.1 let the flag be set and then showed it nowhere.
 */

import type { ReactElement } from 'react';
import { formatCreatedOn } from '@renderer/lib/format';
import { describeRowCount } from '../session-counts';
import type { Company } from '@shared/types';

const ROW_CLASS = 'group flex items-center gap-4 rounded-xl bg-white dark:bg-card-dark p-4 mb-3 shadow-xs ' +
    'transition-all hover:shadow-md border border-transparent dark:border-slate-800/50';
const ICON_CLASS = 'flex shrink-0 items-center justify-center rounded-lg bg-primary/10 dark:bg-primary/20 h-14 w-14';
const NAME_CLASS = 'truncate text-base font-semibold text-slate-900 dark:text-white';
/*
 * flex-wrap, which v1.2.1 did not have. The column this line sits in is overflow-hidden so the long name above can
 * truncate, and at the 380px minimum the meta line measures 188px inside a 146px box - so "Note required", the
 * bullet before it and the tail of the created-on date were cut off with no ellipsis and no way to reach them.
 * Found by tools/baseline/responsive-matrix.mjs at 380x600.
 */
const META_CLASS = 'flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400';
const EDIT_CLASS = 'flex items-center justify-center w-9 h-9 rounded-lg bg-blue-500/10 dark:bg-blue-400/10 ' +
    'hover:bg-blue-500/20 dark:hover:bg-blue-400/20 text-blue-600 dark:text-blue-400 transition-colors';
const DELETE_CLASS = 'flex items-center justify-center w-9 h-9 rounded-lg bg-red-500/10 dark:bg-red-400/10 ' +
    'hover:bg-red-500/20 dark:hover:bg-red-400/20 text-red-600 dark:text-red-400 transition-colors';

interface CompanyRowProps {
    readonly company: Company;
    /** null while the session list has not answered: unknown is not zero (BL-03). */
    readonly sessionCount: number | null;
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
                    <span>{describeRowCount(sessionCount)}</span>
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

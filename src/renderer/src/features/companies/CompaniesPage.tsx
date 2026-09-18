/*
 * COMP-01..04. The screen legacy/pages/companies.html drew, with the same header, empty state, rows and floating
 * action button - and none of the string-built markup underneath them. The session count each row shows is counted
 * here rather than asked for: there is no count-by-company channel, and the list COMP-05 needs answers both.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import ScreenHeader from '@renderer/components/layout/ScreenHeader';
import { ROUTE_PATHS } from '@renderer/lib/routes';
import { useUiStore } from '@renderer/store/ui.store';
import { useCompanies } from './api/useCompanies';
import { useCompanySessions } from './api/useCompanySessions';
import { useCreateCompany, useDeleteCompany, useUpdateCompany } from './api/useCompanyMutations';
import type { CompanyValues } from './api/useCompanyMutations';
import CompanyForm from './components/CompanyForm';
import CompanyRow from './components/CompanyRow';
import {
    DELETE_COUNT_UNKNOWN, countSessionsByCompany, describeCompanyDelete, describeCompanyDeleted, sessionCountFor
} from './session-counts';
import type { Company } from '@shared/types';
import FloatingAction from '@renderer/components/ui/FloatingAction';

const EMPTY_CLASS = 'flex flex-col items-center justify-center py-16 px-6';
const EMPTY_ICON_CLASS = 'flex h-20 w-20 items-center justify-center rounded-full bg-slate-200 dark:bg-card-dark mb-4';
const NEW_COMPANY: CompanyValues = { name: '', noteRequired: false };

export default function CompaniesPage(): ReactElement {
    const companies = useCompanies();
    const sessions = useCompanySessions();
    const create = useCreateCompany();
    const update = useUpdateCompany();
    const remove = useDeleteCompany();
    const pushToast = useUiStore((state) => state.pushToast);
    const openDialog = useUiStore((state) => state.openDialog);
    // null: no form. 'new': the add form. A Company: the edit form for that company.
    const [editing, setEditing] = useState<Company | 'new' | null>(null);

    const rows = companies.data ?? [];
    const counts = countSessionsByCompany(sessions.data ?? []);

    const save = (values: CompanyValues): void => {
        if (values.name === '') {
            pushToast('warning', 'Please enter a company name');
            return;
        }
        if (editing === 'new') {
            create.mutate(values, {
                onSuccess: () => {
                    setEditing(null);
                    pushToast('success', 'Company added successfully');
                }
            });
            return;
        }
        if (editing !== null) {
            update.mutate({ ...values, id: editing.id }, {
                onSuccess: () => {
                    setEditing(null);
                    pushToast('success', 'Company updated successfully');
                }
            });
        }
    };

    /*
     * COMP-05. The count is quoted from the list this screen already holds and checked against what the delete
     * reports: if they disagree, the user was warned about the wrong number and is told so. BL-03: and if the list
     * has not answered there is no count to quote, so no confirmation is opened at all.
     */
    const confirmDelete = (company: Company): void => {
        const expected = sessionCountFor(counts, company.id, sessions.isSuccess);
        if (expected === null) {
            pushToast('warning', DELETE_COUNT_UNKNOWN);
            return;
        }
        void openDialog({
            tone: 'error',
            icon: 'delete',
            title: 'Delete "' + company.name + '"?',
            body: describeCompanyDelete(expected),
            dismissLabel: 'Cancel',
            confirmLabel: 'Delete',
            destructive: true
        }).then((confirmed) => {
            if (!confirmed) {
                return;
            }
            remove.mutate(company.id, {
                onSuccess: (result) => {
                    const removed = result.deletedSessionCount;
                    // WR-03: one condition decides both the colour and the words.
                    pushToast(
                        removed === expected ? 'success' : 'warning',
                        describeCompanyDeleted(removed, expected)
                    );
                }
            });
        });
    };

    return (
        <div className="flex flex-col">
            <ScreenHeader title="Companies" backTo={ROUTE_PATHS.history} />
            <div className="px-4 pb-32">
                {companies.isPending ? <p className="mt-4 text-sm text-slate-400">Loading...</p> : null}
                {companies.isError ? <p className="mt-4 text-sm text-red-400">{companies.error.message}</p> : null}
                {companies.isSuccess && rows.length === 0 ? (
                    <div className={EMPTY_CLASS}>
                        <div className={EMPTY_ICON_CLASS}>
                            <span className="material-symbols-outlined text-4xl text-slate-400">business</span>
                        </div>
                        <h2 className="text-xl font-bold mb-2">No Companies Yet</h2>
                        <p className="text-slate-600 dark:text-slate-400 text-center mb-6">
                            Create your first company to organize your work sessions
                        </p>
                    </div>
                ) : null}
                <section className="mt-2 mb-6">
                    {rows.map((company) => (
                        <CompanyRow
                            key={company.id}
                            company={company}
                            sessionCount={sessionCountFor(counts, company.id, sessions.isSuccess)}
                            onEdit={setEditing}
                            onDelete={confirmDelete}
                        />
                    ))}
                </section>
            </div>
            <FloatingAction label="Add company" onClick={() => { setEditing('new'); }} />
            {editing === null ? null : (
                <CompanyForm
                    mode={editing === 'new' ? 'create' : 'edit'}
                    initial={editing === 'new' ? NEW_COMPANY : editing}
                    busy={create.isPending || update.isPending}
                    onSubmit={save}
                    onDismiss={() => { setEditing(null); }}
                />
            )}
        </div>
    );
}

/*
 * COMP-01..04. The screen legacy/pages/companies.html drew, with the same header, the same empty state, the same
 * rows and the same floating action button - and none of the string-built markup underneath them.
 *
 * The session count each row shows is counted here rather than asked for: there is no count-by-company channel, and
 * the list this screen already needs for COMP-05's warning answers both questions.
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
import { countSessionsByCompany, describeCompanyDelete, describeSessionCount } from './session-counts';
import type { Company } from '@shared/types';

const EMPTY_CLASS = 'flex flex-col items-center justify-center py-16 px-6';
const EMPTY_ICON_CLASS = 'flex h-20 w-20 items-center justify-center rounded-full bg-slate-200 dark:bg-card-dark mb-4';
const FAB_CLASS = 'fixed bottom-28 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-full ' +
    'bg-primary text-white shadow-xl shadow-primary/30 transition-transform hover:scale-110 active:scale-95';
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
     * COMP-05. The count is quoted from the list this screen already holds, and checked against what the delete
     * reports: if they disagree, the user was warned about the wrong number and is told so rather than congratulated.
     */
    const confirmDelete = (company: Company): void => {
        const expected = counts.get(company.id) ?? 0;
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
                    pushToast(
                        removed === expected ? 'success' : 'warning',
                        removed === 0
                            ? 'Company deleted successfully'
                            : 'Company deleted, with ' + describeSessionCount(removed)
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
                            sessionCount={counts.get(company.id) ?? 0}
                            onEdit={setEditing}
                            onDelete={confirmDelete}
                        />
                    ))}
                </section>
            </div>
            <button
                type="button"
                aria-label="Add company"
                className={FAB_CLASS}
                onClick={() => { setEditing('new'); }}
            >
                <span className="material-symbols-outlined text-[28px]">add</span>
            </button>
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

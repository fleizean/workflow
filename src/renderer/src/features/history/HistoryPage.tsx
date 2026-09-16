/*
 * HIST-01..06. legacy/pages/work-history.html's screen, with its three sections actually filled (B8), its goal
 * measured against the user's own target (B6) and its goal filter asking what a day totalled (B7).
 *
 * The whole list is one value from buildHistory and one React commit. v1.2.1 wrote
 * `thisWeekContainer.innerHTML += cardHtml` once per card, so the browser reparsed everything already rendered on
 * every iteration, and then walked the result again to attach a click handler to each card.
 *
 * The Day End export button that sat beside the Companies shortcut is gone with the Google Sheets export the owner
 * removed; the Companies button it shared a row with is kept, now the width of the row.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import ScreenHeader from '@renderer/components/layout/ScreenHeader';
import { ROUTE_PATHS } from '@renderer/lib/routes';
import { useUiStore } from '@renderer/store/ui.store';
import { useCompanies } from '@renderer/features/companies';
import { useSettings } from '@renderer/features/settings';
import { formatLocalDate } from '@shared/utils/date';
import { seedDuration } from '@renderer/lib/duration';
import { useSessions } from './api/useSessions';
import { useWeekTotals } from './api/useWeekTotals';
import { useCreateSession, useDeleteSession, useUpdateSession } from './api/useSessionMutations';
import type { SessionValues } from './api/useSessionMutations';
import FilterPanel from './components/FilterPanel';
import SessionForm from './components/SessionForm';
import type { SessionDraft } from './components/SessionForm';
import SessionGroupCard from './components/SessionGroupCard';
import WeekTotalCard from './components/WeekTotalCard';
import { buildHistory, filtersAreActive, weekRangeLabel } from './grouping';
import type { SessionGroup } from './grouping';
import { useHistoryFilterStore } from './state/filters.store';
import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import type { LocalDate, WorkSession } from '@shared/types';
import FloatingAction from '@renderer/components/ui/FloatingAction';

const FILTER_BUTTON_CLASS: Record<'on' | 'off', string> = {
    on: 'flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-primary text-white transition',
    off: 'flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-slate-200 dark:bg-card-dark ' +
        'text-slate-900 dark:text-white transition hover:bg-slate-300 dark:hover:bg-[#233c48]'
};
const SHORTCUT_CLASS = 'group relative flex items-center gap-3 p-4 rounded-2xl bg-linear-to-br/srgb ' +
    'from-violet-500 to-violet-600 text-white shadow-lg shadow-violet-500/20 transition-all duration-300 ' +
    'active:scale-95 overflow-hidden';
const SHORTCUT_ICON_CLASS = 'relative flex h-10 w-10 items-center justify-center rounded-xl bg-white/20 ' +
    'backdrop-blur-xs z-10';
const SECTION_HEAD_CLASS = 'mb-3 flex items-end justify-between px-1';
const SECTION_TITLE_CLASS = 'text-slate-900 dark:text-white text-lg font-bold leading-tight';
const RANGE_CLASS = 'text-xs font-medium text-slate-500 dark:text-slate-400';

const newDraft = (today: LocalDate): SessionDraft =>
    ({ name: '', duration: seedDuration(0), date: today, companyId: null, note: null });

export default function HistoryPage(): ReactElement {
    const sessions = useSessions();
    const companies = useCompanies();
    const settings = useSettings();
    const weekTotals = useWeekTotals();
    const create = useCreateSession();
    const update = useUpdateSession();
    const remove = useDeleteSession();
    const filters = useHistoryFilterStore((state) => state.filters);
    const applyFilters = useHistoryFilterStore((state) => state.applyFilters);
    const clearFilters = useHistoryFilterStore((state) => state.clearFilters);
    const pushToast = useUiStore((state) => state.pushToast);
    const openDialog = useUiStore((state) => state.openDialog);
    const [panelOpen, setPanelOpen] = useState(false);
    // null: no form. A WorkSession: editing that one. 'new': the add form.
    const [editing, setEditing] = useState<WorkSession | 'new' | null>(null);

    // One "today", read once per render, so two sections cannot disagree about which week it is.
    const today = formatLocalDate(new Date());
    // B6: the user's own target. DEFAULT_SETTINGS is the seeded value, used only while the read is in flight.
    const dailyTargetSeconds = settings.data?.dailyTargetSeconds ?? DEFAULT_SETTINGS.dailyTargetSeconds;
    const companyRows = companies.data ?? [];
    const buckets = buildHistory({
        sessions: sessions.data ?? [],
        companies: companyRows,
        filters,
        dailyTargetSeconds,
        today
    });

    const save = (values: SessionValues): void => {
        if (editing === 'new') {
            create.mutate(values, {
                onSuccess: () => { setEditing(null); pushToast('success', 'Session added successfully'); }
            });
            return;
        }
        if (editing !== null) {
            update.mutate({ ...values, id: editing.id }, {
                onSuccess: () => { setEditing(null); pushToast('success', 'Session updated successfully'); }
            });
        }
    };

    const confirmDelete = (session: WorkSession): void => {
        void openDialog({
            tone: 'error',
            icon: 'delete',
            title: 'Delete Session?',
            body: 'Are you sure you want to delete "' + session.name + '"? This action cannot be undone.',
            dismissLabel: 'Cancel',
            confirmLabel: 'Delete',
            destructive: true
        }).then((confirmed) => {
            if (confirmed) {
                remove.mutate(session.id, {
                    onSuccess: () => { pushToast('success', 'Session deleted successfully'); }
                });
            }
        });
    };

    const section = (title: string, groups: readonly SessionGroup[], range?: string): ReactElement | null => {
        if (groups.length === 0) {
            return null;
        }
        return (
            <section className="mb-6">
                <div className={SECTION_HEAD_CLASS}>
                    <h2 className={SECTION_TITLE_CLASS}>{title}</h2>
                    {range === undefined ? null : <span className={RANGE_CLASS}>{range}</span>}
                </div>
                <div className="flex flex-col gap-3">
                    {groups.map((group) => (
                        <SessionGroupCard
                            key={group.key}
                            group={group}
                            onEdit={setEditing}
                            onDelete={confirmDelete}
                        />
                    ))}
                </div>
            </section>
        );
    };

    const nothing = buckets.thisWeek.length === 0 && buckets.lastWeek.length === 0 && buckets.older.length === 0;

    return (
        <div className="flex flex-col">
            <ScreenHeader title="Work History" backTo={ROUTE_PATHS.home}>
                <button
                    type="button"
                    aria-label="Filter sessions"
                    aria-pressed={filtersAreActive(filters)}
                    className={FILTER_BUTTON_CLASS[filtersAreActive(filters) ? 'on' : 'off']}
                    onClick={() => { setPanelOpen(true); }}
                >
                    <span className="material-symbols-outlined text-[24px]">filter_list</span>
                </button>
            </ScreenHeader>
            <div className="px-4 pb-32">
                <WeekTotalCard thisWeekSeconds={weekTotals.data?.thisWeekSeconds ?? 0} />

                <section className="mb-6">
                    <div className="grid grid-cols-1 gap-3">
                        <Link to={ROUTE_PATHS.companies} className={SHORTCUT_CLASS}>
                            <div className={SHORTCUT_ICON_CLASS}>
                                <span className="material-symbols-outlined text-[22px]">corporate_fare</span>
                            </div>
                            <div className="relative text-left z-10">
                                <p className="text-sm font-bold">Companies</p>
                                <p className="text-[10px] text-white/70 font-medium">Manage &amp; edit</p>
                            </div>
                        </Link>
                    </div>
                </section>

                {sessions.isPending ? <p className="text-sm text-slate-400">Loading...</p> : null}
                {sessions.isError ? <p className="text-sm text-red-400">{sessions.error.message}</p> : null}
                {sessions.isSuccess && nothing ? (
                    <p className="text-slate-600 dark:text-slate-400 text-center py-16">
                        {filtersAreActive(filters)
                            ? 'No sessions match the filters you set.'
                            : 'No work sessions recorded yet.'}
                    </p>
                ) : null}

                {section('This Week', buckets.thisWeek, weekRangeLabel(today, 0))}
                {section('Last Week', buckets.lastWeek, weekRangeLabel(today, 1))}
                {section('Older', buckets.older)}
            </div>

            <FloatingAction label="Add session" onClick={() => { setEditing('new'); }} />

            {panelOpen ? (
                <FilterPanel
                    filters={filters}
                    companies={companyRows}
                    onApply={(next) => { applyFilters(next); setPanelOpen(false); }}
                    onClear={() => { clearFilters(); setPanelOpen(false); }}
                    onDismiss={() => { setPanelOpen(false); }}
                />
            ) : null}

            {editing === null ? null : (
                <SessionForm
                    mode={editing === 'new' ? 'create' : 'edit'}
                    initial={editing === 'new' ? newDraft(today) : {
                        name: editing.name,
                        // BL-01: the stored seconds travel with the boxes, so an edit that leaves them alone
                        // writes the same number back rather than the nearest six minutes.
                        duration: seedDuration(editing.durationSeconds),
                        date: editing.date,
                        companyId: editing.companyId,
                        // WR-01: the stored note travels with the draft, so an untouched empty box is not written
                        // back as the NULL that means nobody has been asked about this row.
                        note: editing.note
                    }}
                    companies={companyRows}
                    today={today}
                    busy={create.isPending || update.isPending}
                    onSubmit={save}
                    onInvalid={(reason) => { pushToast('warning', reason); }}
                    onDismiss={() => { setEditing(null); }}
                />
            )}
        </div>
    );
}

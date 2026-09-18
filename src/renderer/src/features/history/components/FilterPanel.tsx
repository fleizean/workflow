/*
 * The advanced-filter panel: legacy/pages/work-history.html:1000-1090, carried over field for field.
 *
 * It edits a draft and hands the whole thing back on Apply, which is what v1.2.1 did by reading the DOM at the
 * moment the button was pressed. The goal radios are the one place v1.2.1 rewrote className strings by hand on
 * every change; here each state's classes are written out and chosen from a map (C3).
 */

import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import Modal from '@renderer/components/ui/Modal';
import { NO_FILTERS } from '../grouping';
import type { GoalFilter, HistoryFilters, SortBy, SortOrder } from '../grouping';
import type { Company } from '@shared/types';

const TITLE_BLOCK_CLASS = 'flex flex-col items-center justify-center text-center pb-2';
const BADGE_CLASS = 'w-14 h-14 rounded-full bg-linear-to-tr/srgb from-purple-900/50 to-purple-500/20 flex ' +
    'items-center justify-center mb-4 shadow-inner ring-1 ring-white/10';
const TITLE_CLASS = 'text-2xl font-bold text-white tracking-tight';
const LEAD_CLASS = 'text-sm text-gray-400 mt-2 font-medium';
const GROUP_LABEL_CLASS = 'block text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 ml-1';
const SMALL_LABEL_CLASS = 'block text-xs text-gray-500 mb-1.5 ml-1';
const SMALL_FIELD_CLASS = 'w-full px-4 py-3 bg-[#27272a] border border-transparent focus:border-primary/50 ' +
    'text-white rounded-xl focus:ring-4 focus:ring-primary/10 transition-all outline-hidden text-sm ' +
    '[color-scheme:dark]';
const CHECK_ROW_CLASS = 'flex items-center gap-3 p-3 rounded-xl bg-white/5 hover:bg-white/10 cursor-pointer ' +
    'transition-colors border border-white/5';
// The inner company list scrolls too, and legacy/styles/common.css hid its scrollbar along with every other one.
const COMPANY_LIST_CLASS = 'grid grid-cols-1 gap-2 max-h-40 overflow-y-auto pr-2 ' +
    '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
const CHECKBOX_CLASS = 'w-4 h-4 rounded-sm border-gray-600 text-primary focus:ring-primary/50 focus:ring-2 ' +
    'bg-[#27272a]';
const APPLY_CLASS = 'py-4 bg-linear-to-br/srgb from-purple-500 to-purple-600 hover:from-purple-400 ' +
    'hover:to-purple-500 text-white font-semibold rounded-2xl active:scale-95 transition-all duration-200 ' +
    'shadow-lg shadow-purple-500/20';
const CLEAR_CLASS = 'py-4 bg-linear-to-br/srgb from-red-500 to-red-600 hover:from-red-400 hover:to-red-500 ' +
    'text-white font-semibold rounded-2xl active:scale-95 transition-all duration-200 shadow-lg shadow-red-500/20';
const CANCEL_CLASS = 'w-full py-4 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white font-semibold ' +
    'rounded-2xl active:scale-95 transition-all duration-200 border border-white/5';

/* `relative` for the same reason SettingsToggle carries it: `sr-only` is absolute, and without a positioned
 * parent the radio that actually takes focus is positioned against the fixed overlay instead of against this
 * label - outside the panel's own scroll box, which is the one thing that could scroll it into view. */
const GOAL_LABEL_CLASS: Record<'on' | 'off', string> = {
    on: 'relative flex items-center justify-center gap-2 p-3 rounded-xl bg-primary/20 border-primary/50 border ' +
        'cursor-pointer transition-all',
    off: 'relative flex items-center justify-center gap-2 p-3 rounded-xl bg-white/5 border-white/5 border ' +
        'cursor-pointer transition-all'
};
const GOAL_TEXT_CLASS: Record<'on' | 'off', string> = {
    on: 'text-sm font-medium text-primary',
    off: 'text-sm font-medium text-gray-300'
};

const GOAL_OPTIONS: readonly { readonly value: GoalFilter; readonly label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'achieved', label: 'Achieved' },
    { value: 'not-achieved', label: 'Not Yet' }
];

const SORT_BY_OPTIONS: readonly { readonly value: SortBy; readonly label: string }[] = [
    { value: 'date', label: 'Date' },
    { value: 'duration', label: 'Duration' },
    { value: 'name', label: 'Name' }
];

const SORT_ORDER_OPTIONS: readonly { readonly value: SortOrder; readonly label: string }[] = [
    { value: 'desc', label: 'Newest First' },
    { value: 'asc', label: 'Oldest First' }
];

interface FilterPanelProps {
    readonly filters: HistoryFilters;
    readonly companies: readonly Company[];
    readonly onApply: (filters: HistoryFilters) => void;
    readonly onClear: () => void;
    readonly onDismiss: () => void;
}

export default function FilterPanel(props: FilterPanelProps): ReactElement {
    const { filters, companies, onApply, onClear, onDismiss } = props;
    const [draft, setDraft] = useState<HistoryFilters>(filters);
    const titleId = useId();
    const goalName = useId();

    const toggleCompany = (id: number): void => {
        setDraft({
            ...draft,
            companyIds: draft.companyIds.includes(id)
                ? draft.companyIds.filter((value) => value !== id)
                : [...draft.companyIds, id]
        });
    };

    return (
        <Modal
            labelledBy={titleId}
            onDismiss={onDismiss}
            header={(
                <div className={TITLE_BLOCK_CLASS}>
                    <div className={BADGE_CLASS}>
                        <span className="material-symbols-outlined text-primary text-3xl">filter_alt</span>
                    </div>
                    <h2 id={titleId} className={TITLE_CLASS}>Advanced Filters</h2>
                    <p className={LEAD_CLASS}>Filter and sort your work sessions.</p>
                </div>
            )}
        >
            {companies.length === 0 ? null : (
                <div className="mb-6">
                    <p className={GROUP_LABEL_CLASS}>Companies</p>
                    <div className={COMPANY_LIST_CLASS}>
                        {companies.map((company) => (
                            <label key={company.id} className={CHECK_ROW_CLASS}>
                                <input
                                    type="checkbox"
                                    className={CHECKBOX_CLASS}
                                    checked={draft.companyIds.includes(company.id)}
                                    onChange={() => { toggleCompany(company.id); }}
                                />
                                <span className="text-sm text-white font-medium truncate">{company.name}</span>
                            </label>
                        ))}
                    </div>
                </div>
            )}

            <div className="mb-6">
                <p className={GROUP_LABEL_CLASS}>Date Range</p>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label htmlFor={titleId + '-from'} className={SMALL_LABEL_CLASS}>From</label>
                        <input
                            id={titleId + '-from'}
                            type="date"
                            className={SMALL_FIELD_CLASS}
                            value={draft.startDate}
                            onChange={(event) => { setDraft({ ...draft, startDate: event.target.value }); }}
                        />
                    </div>
                    <div>
                        <label htmlFor={titleId + '-to'} className={SMALL_LABEL_CLASS}>To</label>
                        <input
                            id={titleId + '-to'}
                            type="date"
                            className={SMALL_FIELD_CLASS}
                            value={draft.endDate}
                            onChange={(event) => { setDraft({ ...draft, endDate: event.target.value }); }}
                        />
                    </div>
                </div>
            </div>

            <div className="mb-6">
                <p className={GROUP_LABEL_CLASS}>Duration (hours)</p>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label htmlFor={titleId + '-min'} className={SMALL_LABEL_CLASS}>Min</label>
                        <input
                            id={titleId + '-min'}
                            type="number"
                            min="0"
                            step="0.5"
                            placeholder="0"
                            className={SMALL_FIELD_CLASS}
                            value={draft.minHours}
                            onChange={(event) => { setDraft({ ...draft, minHours: event.target.value }); }}
                        />
                    </div>
                    <div>
                        <label htmlFor={titleId + '-max'} className={SMALL_LABEL_CLASS}>Max</label>
                        <input
                            id={titleId + '-max'}
                            type="number"
                            min="0"
                            step="0.5"
                            placeholder="24"
                            className={SMALL_FIELD_CLASS}
                            value={draft.maxHours}
                            onChange={(event) => { setDraft({ ...draft, maxHours: event.target.value }); }}
                        />
                    </div>
                </div>
            </div>

            <div className="mb-6">
                <p className={GROUP_LABEL_CLASS}>Goal Achievement</p>
                <div className="grid grid-cols-3 gap-2">
                    {GOAL_OPTIONS.map((option) => {
                        const state = draft.goal === option.value ? 'on' : 'off';
                        return (
                            <label key={option.value} className={GOAL_LABEL_CLASS[state]}>
                                <input
                                    type="radio"
                                    name={goalName}
                                    className="sr-only"
                                    checked={draft.goal === option.value}
                                    onChange={() => { setDraft({ ...draft, goal: option.value }); }}
                                />
                                <span className={GOAL_TEXT_CLASS[state]}>{option.label}</span>
                            </label>
                        );
                    })}
                </div>
            </div>

            <div className="mb-6">
                <p className={GROUP_LABEL_CLASS}>Sort By</p>
                <div className="grid grid-cols-2 gap-3">
                    <select
                        aria-label="Sort by"
                        className={SMALL_FIELD_CLASS}
                        value={draft.sortBy}
                        onChange={(event) => { setDraft({ ...draft, sortBy: event.target.value as SortBy }); }}
                    >
                        {SORT_BY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                    <select
                        aria-label="Sort order"
                        className={SMALL_FIELD_CLASS}
                        value={draft.sortOrder}
                        onChange={(event) => { setDraft({ ...draft, sortOrder: event.target.value as SortOrder }); }}
                    >
                        {SORT_ORDER_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
                <button type="button" className={APPLY_CLASS} onClick={() => { onApply(draft); }}>
                    Apply Filters
                </button>
                <button
                    type="button"
                    className={CLEAR_CLASS}
                    onClick={() => { setDraft(NO_FILTERS); onClear(); }}
                >
                    Clear All
                </button>
            </div>
            <button type="button" className={CANCEL_CLASS} onClick={onDismiss}>Cancel</button>
        </Modal>
    );
}

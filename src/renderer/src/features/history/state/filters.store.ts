/*
 * The advanced-filter panel's current answer. One feature's own state, which is why it is here and not in store/
 * (ARCH-03).
 *
 * v1.2.1 kept it in localStorage under `sessionFilters`, so it survived a restart. It does not any more: web
 * storage is banned in this renderer because main cannot read it and a cleared profile forgets it, and a filter is
 * not durable user data - it is what the user is looking at right now. It survives every route change, which is
 * what v1.2.1's persistence was actually doing for it, because in v1.2.1 every route change was a page load.
 */

import { create } from 'zustand';
import { NO_FILTERS } from '../grouping';
import type { HistoryFilters } from '../grouping';

interface FilterState {
    readonly filters: HistoryFilters;
    readonly applyFilters: (filters: HistoryFilters) => void;
    readonly clearFilters: () => void;
}

export const useHistoryFilterStore = create<FilterState>((set) => ({
    filters: NO_FILTERS,
    applyFilters: (filters) => { set({ filters }); },
    clearFilters: () => { set({ filters: NO_FILTERS }); }
}));

// CORE-01/COMP-04: the work-session boundary. The note-required rule lives here rather than in a screen, because
// v1.2.1 enforced it in the renderer only (index.html:1264) and every other path into the database bypassed it.

import { invalidInput, notFound, requireFound } from './service-errors';
import type { Company, DayTotal, LocalDate, WorkSession } from '@shared/types';

export interface SessionValues {
    readonly name: string;
    readonly durationSeconds: number;
    readonly date: LocalDate;
    readonly companyId: number | null;
    readonly note: string | null;
}

/** Structural, so nothing here imports src/lib/db: the container passes the repositories themselves. */
export interface SessionsStore {
    list(): WorkSession[];
    listByDateRange(startDate: LocalDate, endDate: LocalDate): WorkSession[];
    listByDateAndCompany(date: LocalDate, companyId: number): WorkSession[];
    create(input: SessionValues): WorkSession;
    update(id: number, input: SessionValues): WorkSession | null;
    remove(id: number): boolean;
    removeAll(): number;
    dayTotals(): DayTotal[];
}

export interface CompanyLookup {
    get(id: number): Company | null;
}

export interface SessionsService {
    list(): WorkSession[];
    listByDateRange(startDate: LocalDate, endDate: LocalDate): WorkSession[];
    listByDateAndCompany(date: LocalDate, companyId: number): WorkSession[];
    create(input: SessionValues): WorkSession;
    update(id: number, input: SessionValues): WorkSession;
    /** Throws NOT_FOUND rather than reporting success for a row that was not there (v1.2.1 returned false). */
    remove(id: number): void;
    removeAll(): number;
}

const hasNote = (note: string | null): boolean => note !== null && note.trim() !== '';

export function createSessionsService(store: SessionsStore, companies: CompanyLookup): SessionsService {
    /** COMP-04: a company that requires a note refuses a session without one, whatever asked for the write. */
    function checked(input: SessionValues): SessionValues {
        if (input.companyId === null) {
            return input;
        }
        const company = requireFound(companies.get(input.companyId), 'that company');
        if (company.noteRequired && !hasNote(input.note)) {
            throw invalidInput(company.name + ' requires a note on every session.');
        }
        return input;
    }

    return {
        list: () => store.list(),
        listByDateRange: (startDate, endDate) => store.listByDateRange(startDate, endDate),
        listByDateAndCompany: (date, companyId) => store.listByDateAndCompany(date, companyId),
        create: (input) => store.create(checked(input)),
        update: (id, input) => requireFound(store.update(id, checked(input)), 'that session'),

        remove(id) {
            if (!store.remove(id)) {
                throw notFound('that session does not exist.');
            }
        },

        removeAll: () => store.removeAll()
    };
}

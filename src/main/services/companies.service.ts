// COMP-01..05: the company boundary. Deleting one takes its sessions with it and says how many, in one transaction -
// v1.2.1 deleted the company alone and left the sessions pointing at a row that no longer existed.

import { conflict, invalidInput, notFound, requireFound } from './service-errors';
import type { Company } from '@shared/types';

export interface CompanyValues {
    readonly name: string;
    readonly noteRequired: boolean;
}

/** Structural, so nothing here imports src/lib/db. */
export interface CompaniesStore {
    list(): Company[];
    get(id: number): Company | null;
    findByName(name: string): Company | null;
    create(input: CompanyValues): Company;
    update(id: number, input: CompanyValues): Company | null;
    remove(id: number): boolean;
}

export interface CompanySessionsStore {
    removeByCompany(companyId: number): number;
}

export interface CompaniesServiceInput {
    readonly companies: CompaniesStore;
    readonly sessions: CompanySessionsStore;
    /** The container's BEGIN IMMEDIATE, so the two deletes below commit together or not at all. */
    readonly transaction: <T>(work: () => T) => T;
}

export interface CompaniesService {
    list(): Company[];
    get(id: number): Company | null;
    create(input: CompanyValues): Company;
    update(id: number, input: CompanyValues): Company;
    /** The company and every session attributed to it, with the count the confirmation dialog quoted (COMP-05). */
    remove(id: number): { readonly deletedSessionCount: number };
}

export function createCompaniesService(input: CompaniesServiceInput): CompaniesService {
    const { companies, sessions, transaction } = input;

    // The column is UNIQUE, so an unchecked duplicate would surface as a driver error the renderer cannot read.
    function named(values: CompanyValues, keepingId: number | null): CompanyValues {
        const name = values.name.trim();
        if (name === '') {
            throw invalidInput('A company needs a name.');
        }
        const existing = companies.findByName(name);
        if (existing !== null && existing.id !== keepingId) {
            throw conflict('A company called ' + name + ' already exists.');
        }
        return { name, noteRequired: values.noteRequired };
    }

    return {
        list: () => companies.list(),
        get: (id) => companies.get(id),
        create: (values) => companies.create(named(values, null)),
        update: (id, values) => requireFound(companies.update(id, named(values, id)), 'that company'),

        remove(id) {
            return transaction(() => {
                const deletedSessionCount = sessions.removeByCompany(id);
                if (!companies.remove(id)) {
                    // Inside the transaction, so the sessions removed above are rolled back with it.
                    throw notFound('that company does not exist.');
                }
                return { deletedSessionCount };
            });
        }
    };
}

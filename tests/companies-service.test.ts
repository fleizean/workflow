// COMP-05: deleting a company takes its sessions with it, in one transaction, and reports how many went - the number
// the confirmation dialog quoted. v1.2.1 deleted the company alone and left the sessions attributed to nothing.

import { describe, expect, it, vi } from 'vitest';
import { createCompaniesService } from '../src/main/services/companies.service';
import { ServiceError } from '../src/main/services/service-errors';
import type { CompaniesStore, CompanySessionsStore } from '../src/main/services/companies.service';
import type { Company } from '../src/shared/types';

// Criterion 3: this suite must pass with electron refusing to load.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

const company = (id: number, name: string): Company => ({ id, name, noteRequired: false, createdAt: 1789000000000 });

interface Harness {
    readonly service: ReturnType<typeof createCompaniesService>;
    readonly rows: Company[];
    readonly sessionsRemoved: number[];
    readonly transactions: number;
    /** What survived the transaction: a rollback puts the removed sessions back. */
    readonly committedSessionRemovals: number[];
}

function harness(options: { rows?: Company[]; sessionsPerCompany?: number } = {}): Harness {
    const rows = options.rows ?? [company(1, 'Contoso'), company(2, 'Northwind')];
    const sessionsRemoved: number[] = [];
    const committedSessionRemovals: number[] = [];
    const state = { transactions: 0 };

    const companies: CompaniesStore = {
        list: () => [...rows],
        get: (id) => rows.find((c) => c.id === id) ?? null,
        findByName: (name) => rows.find((c) => c.name === name) ?? null,
        create: (input) => {
            const created = { ...company(rows.length + 1, input.name), noteRequired: input.noteRequired };
            rows.push(created);
            return created;
        },
        update: (id, input) => {
            const index = rows.findIndex((c) => c.id === id);
            if (index < 0) return null;
            const updated = { ...(rows[index] as Company), ...input };
            rows[index] = updated;
            return updated;
        },
        remove: (id) => {
            const index = rows.findIndex((c) => c.id === id);
            if (index < 0) return false;
            rows.splice(index, 1);
            return true;
        }
    };

    const sessions: CompanySessionsStore = {
        removeByCompany: (companyId) => {
            sessionsRemoved.push(companyId);
            return options.sessionsPerCompany ?? 3;
        }
    };

    // A real BEGIN IMMEDIATE rolls the whole body back; this records the same outcome.
    const transaction = <T>(work: () => T): T => {
        state.transactions += 1;
        const before = [...sessionsRemoved];
        try {
            const result = work();
            committedSessionRemovals.push(...sessionsRemoved.slice(before.length));
            return result;
        } catch (error) {
            sessionsRemoved.length = before.length;
            throw error;
        }
    };

    return {
        service: createCompaniesService({ companies, sessions, transaction }),
        rows,
        sessionsRemoved,
        get transactions() { return state.transactions; },
        committedSessionRemovals
    };
}

const refusal = (work: () => unknown): ServiceError => {
    try {
        work();
    } catch (error) {
        if (error instanceof ServiceError) return error;
        throw error;
    }
    throw new Error('the call was expected to be refused and was not');
};

describe('COMP-05: deleting a company', () => {
    it('removes its sessions and the company in one transaction, and says how many', () => {
        const h = harness();
        expect(h.service.remove(1)).toEqual({ deletedSessionCount: 3 });
        expect(h.transactions, 'the two deletes did not share a transaction').toBe(1);
        expect(h.sessionsRemoved).toEqual([1]);
        expect(h.rows.map((c) => c.name)).toEqual(['Northwind']);
    });

    it('rolls the session deletes back when the company is not there', () => {
        const h = harness();
        expect(refusal(() => h.service.remove(404)).code).toBe('NOT_FOUND');
        expect(h.committedSessionRemovals, 'sessions were deleted for a company that does not exist').toEqual([]);
        expect(h.rows).toHaveLength(2);
    });
});

describe('COMP-01/COMP-02: naming a company', () => {
    it('trims the name it stores', () => {
        const h = harness();
        expect(h.service.create({ name: '  Fabrikam  ', noteRequired: true }).name).toBe('Fabrikam');
    });

    it.each(['', '   '])('refuses %j as a name', (name) => {
        const h = harness();
        expect(refusal(() => h.service.create({ name, noteRequired: false })).code).toBe('INVALID_INPUT');
    });

    it('refuses a duplicate rather than letting the UNIQUE column answer with a driver error', () => {
        const h = harness();
        const error = refusal(() => h.service.create({ name: 'Contoso', noteRequired: false }));
        expect(error.code).toBe('CONFLICT');
        expect(error.message).toContain('Contoso');
        expect(h.rows).toHaveLength(2);
    });

    it('lets a company keep its own name while renaming, and refuses another company\'s', () => {
        const h = harness();
        expect(h.service.update(1, { name: 'Contoso', noteRequired: true }).noteRequired).toBe(true);
        expect(refusal(() => h.service.update(1, { name: 'Northwind', noteRequired: false })).code).toBe('CONFLICT');
    });

    it('reports an edit of a company that is not there as NOT_FOUND', () => {
        const h = harness();
        expect(refusal(() => h.service.update(404, { name: 'Ghost', noteRequired: false })).code).toBe('NOT_FOUND');
    });

    it('reads through to the store untouched', () => {
        const h = harness();
        expect(h.service.list().map((c) => c.name)).toEqual(['Contoso', 'Northwind']);
        expect(h.service.get(2)?.name).toBe('Northwind');
        expect(h.service.get(404)).toBeNull();
    });
});

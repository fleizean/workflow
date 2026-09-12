// COMP-04: a company that requires a note refuses a session without one, wherever the write comes from. v1.2.1
// checked this in the renderer only (src/pages/index.html:1264), so the rule was one screen's opinion.

import { describe, expect, it, vi } from 'vitest';
import { createSessionsService } from '../src/main/services/sessions.service';
import { ServiceError } from '../src/main/services/service-errors';
import type { CompanyLookup, SessionValues, SessionsStore } from '../src/main/services/sessions.service';
import type { Company, LocalDate, WorkSession } from '../src/shared/types';

// Criterion 3: this suite must pass with electron refusing to load.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

const DAY = '2026-09-12' as LocalDate;

const company = (id: number, noteRequired: boolean): Company =>
    ({ id, name: 'Company ' + String(id), noteRequired, createdAt: 1789000000000 });

const STORED: WorkSession = {
    id: 1, name: 'Deep work', durationSeconds: 1800, date: DAY, companyId: 1, note: null, createdAt: 1789000000000
};

interface Harness {
    readonly service: ReturnType<typeof createSessionsService>;
    readonly writes: SessionValues[];
    readonly removed: number[];
}

function harness(options: { companies?: Company[]; updateFinds?: boolean; removeFinds?: boolean } = {}): Harness {
    const companies = options.companies ?? [company(1, false), company(2, true)];
    const writes: SessionValues[] = [];
    const removed: number[] = [];

    const store: SessionsStore = {
        list: () => [STORED],
        listByDateRange: () => [STORED],
        listByDateAndCompany: () => [STORED],
        create: (input) => { writes.push(input); return { ...STORED, ...input }; },
        update: (id, input) => {
            writes.push(input);
            return options.updateFinds === false ? null : { ...STORED, ...input, id };
        },
        remove: (id) => { removed.push(id); return options.removeFinds !== false; },
        removeAll: () => 4,
        dayTotals: () => []
    };
    const lookup: CompanyLookup = { get: (id) => companies.find((c) => c.id === id) ?? null };

    return { service: createSessionsService(store, lookup), writes, removed };
}

const values = (overrides: Partial<SessionValues> = {}): SessionValues =>
    ({ name: 'Deep work', durationSeconds: 1800, date: DAY, companyId: 1, note: null, ...overrides });

const refusal = (work: () => unknown): ServiceError => {
    try {
        work();
    } catch (error) {
        if (error instanceof ServiceError) return error;
        throw error;
    }
    throw new Error('the call was expected to be refused and was not');
};

describe('COMP-04: note-required is enforced by the service, not by a screen', () => {
    it('writes a session for a company that does not require a note', () => {
        const h = harness();
        expect(h.service.create(values()).companyId).toBe(1);
        expect(h.writes).toHaveLength(1);
    });

    it('refuses one for a company that does, and writes nothing', () => {
        const h = harness();
        const error = refusal(() => h.service.create(values({ companyId: 2 })));
        expect(error.code).toBe('INVALID_INPUT');
        expect(error.message).toContain('requires a note');
        expect(h.writes, 'the session was written despite the refusal').toEqual([]);
    });

    it.each([null, '', '   ', '\t\n'])('treats %j as no note at all', (note) => {
        const h = harness();
        expect(refusal(() => h.service.create(values({ companyId: 2, note }))).code).toBe('INVALID_INPUT');
    });

    it('accepts a session with a note for that same company', () => {
        const h = harness();
        expect(h.service.create(values({ companyId: 2, note: 'Quarterly review' })).note).toBe('Quarterly review');
    });

    it('applies the rule to an edit as well as to a first write', () => {
        const h = harness();
        expect(refusal(() => h.service.update(1, values({ companyId: 2 }))).code).toBe('INVALID_INPUT');
        expect(h.writes).toEqual([]);
    });

    it('leaves an unattributed session alone: there is no company to require anything', () => {
        const h = harness();
        expect(h.service.create(values({ companyId: null, note: null })).companyId).toBeNull();
    });

    it('refuses a session attributed to a company that does not exist', () => {
        const h = harness();
        expect(refusal(() => h.service.create(values({ companyId: 99 }))).code).toBe('NOT_FOUND');
        expect(h.writes).toEqual([]);
    });
});

describe('the rest of the session surface', () => {
    it('reports an edit of a session that is not there as NOT_FOUND rather than as success', () => {
        const h = harness({ updateFinds: false });
        expect(refusal(() => h.service.update(404, values())).code).toBe('NOT_FOUND');
    });

    it('reports a delete that removed nothing the same way (v1.2.1 returned false and the UI ignored it)', () => {
        const h = harness({ removeFinds: false });
        expect(refusal(() => h.service.remove(404)).code).toBe('NOT_FOUND');
        expect(h.removed).toEqual([404]);
    });

    it('deletes a session that is there, and says how many deleteAll removed', () => {
        const h = harness();
        expect(() => h.service.remove(1)).not.toThrow();
        expect(h.service.removeAll()).toBe(4);
    });

    it('reads through to the store untouched', () => {
        const h = harness();
        expect(h.service.list()).toEqual([STORED]);
        expect(h.service.listByDateRange(DAY, DAY)).toEqual([STORED]);
        expect(h.service.listByDateAndCompany(DAY, 1)).toEqual([STORED]);
    });
});

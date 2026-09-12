// companies. Selects its columns by name rather than *, so the retired export columns cannot reach a caller even by
// accident: the domain Company is id, name, noteRequired and createdAt, and that is the whole surface.

import { asc, eq, sql } from 'drizzle-orm';
import { companies } from '../schema';
import { mapRow, mapRows, requireEpochMs, requireId, requireText, storedFlag } from './rows';
import type { CompanyRow } from '../schema';
import type { DbHandle } from '../handle';
import type { RepositoryOptions } from './rows';
import type { Company } from '@shared/types';

const TABLE = 'companies';

export interface CompanyInput {
    readonly name: string;
    readonly noteRequired: boolean;
}

export interface CompaniesRepository {
    list(): Company[];
    get(id: number): Company | null;
    findByName(name: string): Company | null;
    create(input: CompanyInput): Company;
    update(id: number, input: CompanyInput): Company | null;
    remove(id: number): boolean;
}

const DOMAIN_COLUMNS = {
    id: companies.id,
    name: companies.name,
    note_required: companies.note_required,
    created_at: companies.created_at
};

// Derived from the schema, never restated: a renamed column is a compile error here too (D-11, CORE-16).
type CompanyColumns = Pick<CompanyRow, 'id' | 'name' | 'note_required' | 'created_at'>;

function toCompany(row: CompanyColumns): Company {
    return {
        id: requireId('id', row.id),
        name: requireText('name', row.name),
        noteRequired: storedFlag(row.note_required),
        createdAt: requireEpochMs('created_at', row.created_at)
    };
}

export function createCompaniesRepository(handle: DbHandle, options: RepositoryOptions = {}): CompaniesRepository {
    const select = () => handle.select(DOMAIN_COLUMNS).from(companies);

    return {
        list() {
            return mapRows(TABLE, select().orderBy(asc(companies.name)).all(), toCompany, options);
        },

        get(id) {
            return mapRow(TABLE, select().where(eq(companies.id, id)).get(), toCompany, options);
        },

        findByName(name) {
            return mapRow(TABLE, select().where(eq(companies.name, name)).get(), toCompany, options);
        },

        create(input) {
            return toCompany(handle.insert(companies)
                .values({ name: input.name, note_required: input.noteRequired ? 1 : 0 })
                .returning(DOMAIN_COLUMNS).get());
        },

        update(id, input) {
            // updated_at is bumped exactly as v1.2.1 did; it is not part of the domain object.
            const updated = handle.update(companies)
                .set({ name: input.name, note_required: input.noteRequired ? 1 : 0, updated_at: sql`CURRENT_TIMESTAMP` })
                .where(eq(companies.id, id)).returning(DOMAIN_COLUMNS).get();
            return updated === undefined ? null : toCompany(updated);
        },

        remove(id) {
            return handle.delete(companies).where(eq(companies.id, id)).run().changes > 0;
        }
    };
}

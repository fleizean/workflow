// work_sessions. The only module that knows this table's column names; callers see WorkSession and DayTotal.

import { and, asc, between, desc, eq, sql } from 'drizzle-orm';
import { workSessions } from '../schema';
import {
    mapRow, mapRows, optionalId, optionalText, requireEpochMs, requireId, requireLocalDate, requireText,
    requireWholeSeconds
} from './rows';
import type { WorkSessionRow } from '../schema';
import type { DbHandle } from '../handle';
import type { RepositoryOptions } from './rows';
import type { DayTotal, LocalDate, WorkSession } from '@shared/types';

const TABLE = 'work_sessions';

export interface SessionInput {
    readonly name: string;
    readonly durationSeconds: number;
    readonly date: LocalDate;
    readonly companyId: number | null;
    readonly note: string | null;
}

export interface SessionsRepository {
    list(): WorkSession[];
    listByDateRange(startDate: LocalDate, endDate: LocalDate): WorkSession[];
    listByDateAndCompany(date: LocalDate, companyId: number): WorkSession[];
    get(id: number): WorkSession | null;
    create(input: SessionInput): WorkSession;
    update(id: number, input: SessionInput): WorkSession | null;
    remove(id: number): boolean;
    removeAll(): number;
    removeByCompany(companyId: number): number;
    /** Every local day that has sessions, with its total. The unit CORE-08 computes every statistic from. */
    dayTotals(): DayTotal[];
}

function toSession(row: WorkSessionRow): WorkSession {
    return {
        id: requireId('id', row.id),
        name: requireText('name', row.name),
        durationSeconds: requireWholeSeconds('duration', row.duration),
        date: requireLocalDate('date', row.date),
        companyId: optionalId('company_id', row.company_id),
        note: optionalText('note', row.note),
        createdAt: requireEpochMs('created_at', row.created_at)
    };
}

// created_at is deliberately absent from every insert and update: SQLite's own CURRENT_TIMESTAMP default fills it,
// exactly as v1.2.1 did, so the stored text keeps one format.
const columnsOf = (input: SessionInput) => ({
    name: input.name,
    duration: input.durationSeconds,
    date: input.date,
    company_id: input.companyId,
    note: input.note
});

export function createSessionsRepository(handle: DbHandle, options: RepositoryOptions = {}): SessionsRepository {
    const rows = (found: WorkSessionRow[]): WorkSession[] => mapRows(TABLE, found, toSession, options);

    return {
        list() {
            return rows(handle.select().from(workSessions).orderBy(desc(workSessions.created_at)).all());
        },

        listByDateRange(startDate, endDate) {
            return rows(handle.select().from(workSessions)
                .where(between(workSessions.date, startDate, endDate))
                .orderBy(desc(workSessions.date)).all());
        },

        listByDateAndCompany(date, companyId) {
            return rows(handle.select().from(workSessions)
                .where(and(eq(workSessions.date, date), eq(workSessions.company_id, companyId)))
                .orderBy(asc(workSessions.created_at)).all());
        },

        get(id) {
            return mapRow(TABLE, handle.select().from(workSessions).where(eq(workSessions.id, id)).get(), toSession, options);
        },

        create(input) {
            const inserted = handle.insert(workSessions).values(columnsOf(input)).returning().get();
            return toSession(inserted);
        },

        update(id, input) {
            const updated = handle.update(workSessions).set(columnsOf(input))
                .where(eq(workSessions.id, id)).returning().get();
            return updated === undefined ? null : toSession(updated);
        },

        remove(id) {
            return handle.delete(workSessions).where(eq(workSessions.id, id)).run().changes > 0;
        },

        removeAll() {
            return handle.delete(workSessions).run().changes;
        },

        removeByCompany(companyId) {
            return handle.delete(workSessions).where(eq(workSessions.company_id, companyId)).run().changes;
        },

        dayTotals() {
            // sum() over no rows is NULL, and a day total that renders as "null" is DATA-05; coalesce is the reason
            // this one aggregate is written as a sql template. Both column references are still schema-bound, so a
            // renamed column is a compile error here too.
            const totals = handle.select({
                date: workSessions.date,
                totalSeconds: sql<number>`coalesce(sum(${workSessions.duration}), 0)`
            }).from(workSessions)
                // The same rows list() returns: a duration SQLite did not store as a non-negative integer is not a
                // length of time, and a total that counted it would disagree with the sessions on screen.
                .where(sql`typeof(${workSessions.duration}) = 'integer' AND ${workSessions.duration} >= 0`)
                .groupBy(workSessions.date).orderBy(desc(workSessions.date)).all();

            return mapRows(TABLE, totals, (row): DayTotal => ({
                date: requireLocalDate('date', row.date),
                totalSeconds: requireWholeSeconds('duration', row.totalSeconds)
            }), options);
        }
    };
}

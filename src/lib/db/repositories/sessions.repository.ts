// work_sessions. The only module that knows this table's column names; callers see WorkSession and DayTotal.

import { and, asc, between, desc, eq, sql } from 'drizzle-orm';
import { isLocalDate } from '@shared/utils/date';
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
    /** One day's total, asked of that day rather than of every day the table has ever held (WR-09). */
    dayTotalFor(date: LocalDate): number;
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
/*
 * WR-10: the predicate the aggregates share with toSession. dayTotals() filtered `duration` alone while its comment
 * claimed "the same rows list() returns", so a row list() drops - a BLOB in note, a text company_id, a name that is
 * not text - was still counted in the day's total. Work History then showed eight sessions totalling seven hours
 * while the progress card, the streak and the week totals all said eight, with no visible session to explain the
 * difference and no way to edit or delete the one that caused it.
 *
 * created_at is the one predicate this cannot share: toSession also requires it to parse as a SQL timestamp, and
 * that parse lives in date.ts. The type check below catches a created_at that is not text at all; a text value that
 * does not parse is still counted here and still dropped by list(). That remainder is stated rather than claimed
 * away, and the liberal SQL_TIMESTAMP regex makes it narrow.
 */
const LISTABLE = sql`typeof(${workSessions.duration}) = 'integer' AND ${workSessions.duration} >= 0
    AND typeof(${workSessions.name}) = 'text'
    AND typeof(${workSessions.created_at}) = 'text'
    AND (${workSessions.company_id} IS NULL
        OR (typeof(${workSessions.company_id}) = 'integer' AND ${workSessions.company_id} > 0))
    AND (${workSessions.note} IS NULL OR typeof(${workSessions.note}) = 'text')`;

const COUNTED_SECONDS = sql<number>`coalesce(sum(CASE WHEN ${LISTABLE} THEN ${workSessions.duration} END), 0)`;
const COUNTED_ROWS = sql<number>`coalesce(sum(CASE WHEN ${LISTABLE} THEN 1 ELSE 0 END), 0)`;
const UNCOUNTED_ROWS = sql<number>`coalesce(sum(CASE WHEN ${LISTABLE} THEN 0 ELSE 1 END), 0)`;

/** By count and by day, never by value: a session name or a note is user data (the mapper's rule). */
function reportUncounted(date: unknown, uncounted: unknown, options: RepositoryOptions): void {
    if (typeof uncounted !== 'number' || uncounted <= 0) return;
    options.onSkippedRow?.({
        table: TABLE,
        column: 'duration',
        rowId: null,
        reason: String(uncounted) + ' row(s) on ' + (isLocalDate(date) ? date : 'an unreadable day') +
            ' are left out of the sessions list, so the day total leaves them out too'
    });
}

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

        /*
         * IN-06: the write paths map outside mapRows, so a RowMappingError here is thrown rather than swallowed -
         * the one place this layer's "a bad row is skipped, never thrown" rule is inverted, and it is deliberate.
         * A read that drops an unreadable row loses nothing; a write that returned a WorkSession the mapper could
         * not build would be inventing one, and swallowing it would report success with nothing to hand back. The
         * INSERT has committed by then, so a caller who retries duplicates the session - which is why every field
         * crossing sessions:create is bounded by the contract's schemas first, and why nothing can reach this today.
         */
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

        // WR-09: the same sum as dayTotals, for one date. The goal decision asks this on the timer's tick, and
        // aggregating a user's whole history to read one day grows with their history - on the clock's own thread,
        // where a slow read is a late tick.
        dayTotalFor(date) {
            const row = handle.select({ totalSeconds: COUNTED_SECONDS, uncounted: UNCOUNTED_ROWS })
                .from(workSessions).where(eq(workSessions.date, date)).get();

            reportUncounted(date, row?.uncounted, options);
            const total = mapRow(TABLE, row, (found) => requireWholeSeconds('duration', found.totalSeconds), options);
            return total ?? 0;
        },

        dayTotals() {
            // sum() over no rows is NULL, and a day total that renders as "null" is DATA-05; coalesce is the reason
            // this one aggregate is written as a sql template. Both column references are still schema-bound, so a
            // renamed column is a compile error here too.
            const totals = handle.select({
                date: workSessions.date,
                totalSeconds: COUNTED_SECONDS,
                counted: COUNTED_ROWS,
                uncounted: UNCOUNTED_ROWS
            }).from(workSessions)
                .groupBy(workSessions.date).orderBy(desc(workSessions.date)).all();

            for (const row of totals) reportUncounted(row.date, row.uncounted, options);
            // A day whose every row is unlistable shows no sessions, so it has no total either - which is the day
            // set the WHERE this replaced produced, now under the whole predicate rather than duration alone.
            const days = totals.filter((row) => typeof row.counted === 'number' && row.counted > 0);

            return mapRows(TABLE, days, (row): DayTotal => ({
                date: requireLocalDate('date', row.date),
                totalSeconds: requireWholeSeconds('duration', row.totalSeconds)
            }), options);
        }
    };
}

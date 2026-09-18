// pomodoro_sessions. One row per completed pomodoro, as v1.2.1 wrote them; the long-break counter reads a local day
// through countForDay, never a number kept in memory across a restart (SC5).

import { asc, eq, sql } from 'drizzle-orm';
import { pomodoroSessions } from '../schema';
import { mapRows, optionalId, requireCount, requireId, requireLocalDate } from './rows';
import type { PomodoroSessionRow } from '../schema';
import type { DbHandle } from '../handle';
import type { RepositoryOptions } from './rows';
import type { LocalDate, PomodoroSession } from '@shared/types';

const TABLE = 'pomodoro_sessions';

export interface PomodoroRepository {
    listByDate(date: LocalDate): PomodoroSession[];
    /** Pomodoros completed on a local day, summed across companies. 0 when the day has no rows. */
    countForDay(date: LocalDate): number;
    recordCompletion(date: LocalDate, companyId: number | null): PomodoroSession;
}

const DOMAIN_COLUMNS = {
    id: pomodoroSessions.id,
    date: pomodoroSessions.date,
    company_id: pomodoroSessions.company_id,
    pomodoros_completed: pomodoroSessions.pomodoros_completed
};

// Derived from the schema, never restated: a renamed column is a compile error here too (D-11, CORE-16).
type PomodoroColumns = Pick<PomodoroSessionRow, 'id' | 'date' | 'company_id' | 'pomodoros_completed'>;

function toPomodoroSession(row: PomodoroColumns): PomodoroSession {
    return {
        id: requireId('id', row.id),
        date: requireLocalDate('date', row.date),
        companyId: optionalId('company_id', row.company_id),
        // v1.2.1's ALTER left the column nullable; SUM ignores NULL, so an unset count contributes nothing.
        pomodorosCompleted: requireCount('pomodoros_completed', row.pomodoros_completed ?? 0)
    };
}

export function createPomodoroRepository(handle: DbHandle, options: RepositoryOptions = {}): PomodoroRepository {
    return {
        listByDate(date) {
            const found = handle.select(DOMAIN_COLUMNS).from(pomodoroSessions)
                .where(eq(pomodoroSessions.date, date)).orderBy(asc(pomodoroSessions.created_at)).all();
            return mapRows(TABLE, found, toPomodoroSession, options);
        },

        countForDay(date) {
            /*
             * WR-09: the bad row is excluded, not the day. SQLite columns are dynamically typed, so summing a text
             * value and then refusing the unsafe result collapsed the whole day to zero - the long break unreachable
             * for the rest of it, and POMO-09's week under-reported. Filtered in SQL as dayTotals() filters
             * duration, with the excluded rows reported. coalesce because sum() over no rows is NULL (DATA-05).
             */
            const countable = sql`typeof(${pomodoroSessions.pomodoros_completed}) = 'integer'
                AND ${pomodoroSessions.pomodoros_completed} >= 0`;
            const row = handle.select({
                total: sql<number>`coalesce(sum(CASE WHEN ${countable} THEN ${pomodoroSessions.pomodoros_completed} END), 0)`,
                // NULL is what v1.2.1's ALTER left behind and sum() ignores it, so it is not an anomaly to report.
                skipped: sql<number>`coalesce(sum(CASE WHEN ${countable}
                    OR ${pomodoroSessions.pomodoros_completed} IS NULL THEN 0 ELSE 1 END), 0)`
            }).from(pomodoroSessions).where(eq(pomodoroSessions.date, date)).get();

            const skipped = row?.skipped ?? 0;
            if (typeof skipped === 'number' && skipped > 0) {
                options.onSkippedRow?.({
                    table: TABLE,
                    column: 'pomodoros_completed',
                    rowId: null,
                    reason: String(skipped) + ' row(s) on this day are not a whole non-negative count'
                });
            }

            const total = row?.total ?? 0;
            return Number.isSafeInteger(total) && total > 0 ? total : 0;
        },

        recordCompletion(date, companyId) {
            // created_at comes from the column default, as it did in v1.2.1.
            return toPomodoroSession(handle.insert(pomodoroSessions)
                .values({ date, company_id: companyId, pomodoros_completed: 1 })
                .returning(DOMAIN_COLUMNS).get());
        }
    };
}

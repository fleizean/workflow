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
            // coalesce for the same reason the day totals need it: sum() over no rows is NULL (DATA-05).
            const row = handle.select({
                total: sql<number>`coalesce(sum(${pomodoroSessions.pomodoros_completed}), 0)`
            }).from(pomodoroSessions).where(eq(pomodoroSessions.date, date)).get();
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

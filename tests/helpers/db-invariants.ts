// D-23: what must survive a migration - per-table counts, a content digest over every original v1.x column,
// sqlite_sequence, the settings map, per-date totals, and v1.2.1's streak rule recomputed from those totals.

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { addDays, diffDays, isoWeekday } from '@shared/utils/date';
import type { LocalDate } from '@shared/utils/date';
import { V121_DEFAULT_SETTINGS } from './v121-sql';

export const INVARIANT_TABLES = ['companies', 'work_sessions', 'settings', 'pomodoro_sessions'] as const;

export type V121Table = (typeof INVARIANT_TABLES)[number];

// The cell v1.2.1 fills from CURRENT_TIMESTAMP when it inserts Unassigned: no prediction can name it.
export const TIMESTAMP_SENTINEL = '<CURRENT_TIMESTAMP>';

const TIMESTAMP_TEXT = /^'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'$/;

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Rows are ordered by primary key, so equal-content rows cannot mask a lost or duplicated one.
const PRIMARY_KEY: Readonly<Record<V121Table, string>> = {
    companies: 'id',
    work_sessions: 'id',
    settings: 'key',
    pomodoro_sessions: 'id'
};

const V121_DEFAULT_TARGET = '28800';

export interface TableInvariant {
    // The columns the file had when this capture was taken, in cid order.
    readonly columns: readonly string[];
    // Every cell through SQLite quote(), so a type change (90.5 -> '90.5') is visible.
    readonly rows: readonly (readonly string[])[];
    readonly digest: string;
}

export interface DatabaseInvariants {
    // null marks a table the file does not have; nothing about it can be preserved.
    readonly tables: Readonly<Record<V121Table, TableInvariant | null>>;
    readonly counts: Readonly<Record<V121Table, number | null>>;
    readonly totalDuration: number | null;
    readonly sqliteSequence: Readonly<Record<string, number>>;
    readonly settings: Readonly<Record<string, string>> | null;
    readonly dayTotals: Readonly<Record<string, number>>;
}

// SQLite's own quote() for a text value, so predictions and captures render identically.
function quoteText(value: string): string {
    return '\'' + value.replace(/'/g, '\'\'') + '\'';
}

function digestOf(columns: readonly string[], rows: readonly (readonly string[])[]): string {
    const hash = createHash('sha256');
    hash.update(JSON.stringify(columns));
    for (const row of rows) {
        hash.update(JSON.stringify(row));
    }
    return hash.digest('hex');
}

function identifier(name: string, table: string): string {
    if (!SAFE_IDENTIFIER.test(name)) {
        throw new Error('db-invariants: refusing to read column ' + JSON.stringify(name) + ' of ' + table);
    }
    return name;
}

function presentTables(db: Database.Database): Set<string> {
    return new Set(
        db.prepare<[], { name: string }>('SELECT name FROM sqlite_master WHERE type = \'table\'')
            .all().map((row) => row.name)
    );
}

function columnsOf(db: Database.Database, table: V121Table): string[] {
    return db.prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all(table).map((row) => row.name);
}

function readTable(db: Database.Database, table: V121Table, columns: readonly string[]): TableInvariant {
    const quoted = columns
        .map((column) => 'quote("' + identifier(column, table) + '")')
        .join(', ');
    // `table` and the primary key are module constants; every column name is identifier-checked above.
    const sql = 'SELECT ' + quoted + ' FROM "' + table + '" ORDER BY "' + PRIMARY_KEY[table] + '"';
    const rows = db.prepare(sql).raw().all().map((row) => (row as unknown[]).map((cell) => String(cell)));
    return { columns: [...columns], rows, digest: digestOf(columns, rows) };
}

export interface CaptureOptions {
    // The columns each table had before the migration; a capture after one must digest exactly those.
    readonly over?: Readonly<Partial<Record<V121Table, readonly string[]>>>;
}

export function captureInvariants(dbPath: string, options: CaptureOptions = {}): DatabaseInvariants {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const present = presentTables(db);
        const tables: Record<V121Table, TableInvariant | null> = {
            companies: null, work_sessions: null, settings: null, pomodoro_sessions: null
        };
        const counts: Record<V121Table, number | null> = {
            companies: null, work_sessions: null, settings: null, pomodoro_sessions: null
        };

        for (const table of INVARIANT_TABLES) {
            if (!present.has(table)) continue;
            const live = columnsOf(db, table);
            const wanted = options.over?.[table] ?? live;
            const lost = wanted.filter((column) => !live.includes(column));
            if (lost.length > 0) {
                throw new Error('db-invariants: ' + table + ' lost ' + String(lost.length) + ' original column(s): ' +
                    lost.join(', '));
            }
            tables[table] = readTable(db, table, wanted);
            const counted = db.prepare<[], { c: number }>('SELECT count(*) AS c FROM "' + table + '"').get();
            counts[table] = counted?.c ?? 0;
        }

        let totalDuration: number | null = null;
        const dayTotals: Record<string, number> = {};
        if (present.has('work_sessions')) {
            // sum() over zero rows is NULL; COALESCE keeps an empty table at an exact integer 0.
            const summed = db.prepare<[], { s: number }>(
                'SELECT COALESCE(sum(duration), 0) AS s FROM work_sessions'
            ).get();
            totalDuration = summed?.s ?? 0;
            const grouped = db.prepare<[], { date: string; total: number }>(
                'SELECT date, SUM(duration) AS total FROM work_sessions GROUP BY date'
            ).all();
            for (const row of grouped) {
                dayTotals[String(row.date)] = row.total;
            }
        }

        const sqliteSequence: Record<string, number> = {};
        if (present.has('sqlite_sequence')) {
            for (const row of db.prepare<[], { name: string; seq: number }>(
                'SELECT name, seq FROM sqlite_sequence'
            ).all()) {
                sqliteSequence[row.name] = row.seq;
            }
        }

        let settings: Record<string, string> | null = null;
        if (present.has('settings')) {
            settings = {};
            for (const row of db.prepare<[], { key: string; value: string }>(
                'SELECT key, value FROM settings'
            ).all()) {
                settings[row.key] = row.value;
            }
        }

        return { tables, counts, totalDuration, sqliteSequence, settings, dayTotals };
    } finally {
        db.close();
    }
}

// The columns a capture saw, for a second capture to digest the same set (D-19 adds none, so they must match).
export function originalColumns(
    invariants: DatabaseInvariants
): Readonly<Partial<Record<V121Table, readonly string[]>>> {
    const over: Partial<Record<V121Table, readonly string[]>> = {};
    for (const table of INVARIANT_TABLES) {
        const captured = invariants.tables[table];
        if (captured !== null) over[table] = captured.columns;
    }
    return over;
}

function cellIndex(columns: readonly string[], name: string): number {
    return columns.indexOf(name);
}

// v1.2.1 inserts Unassigned naming only `name`; every other column takes its declared default.
function unassignedRow(columns: readonly string[], id: number): string[] {
    return columns.map((column) => {
        if (column === 'id') return String(id);
        if (column === 'name') return quoteText('Unassigned');
        if (column === 'created_at' || column === 'updated_at') return TIMESTAMP_SENTINEL;
        if (column === 'note_required') return '0';
        return 'NULL';
    });
}

// D-13's three predicted changes, stated explicitly: the Unassigned row when absent, NULL company ids
// reassigned to it, and the missing raw defaults added. Nothing else may differ.
export function predictAdoption(before: DatabaseInvariants): DatabaseInvariants {
    const companies = before.tables.companies;
    const sequence: Record<string, number> = { ...before.sqliteSequence };
    const counts: Record<V121Table, number | null> = { ...before.counts };
    const tables: Record<V121Table, TableInvariant | null> = { ...before.tables };

    let unassignedId: number | null = null;

    if (companies !== null) {
        const idAt = cellIndex(companies.columns, 'id');
        const nameAt = cellIndex(companies.columns, 'name');
        const existing = nameAt === -1
            ? undefined
            : companies.rows.find((row) => row[nameAt] === quoteText('Unassigned'));

        if (existing !== undefined && idAt !== -1) {
            unassignedId = Number(existing[idAt]);
        } else if (idAt !== -1) {
            const maxId = companies.rows.reduce((high, row) => Math.max(high, Number(row[idAt])), 0);
            // AUTOINCREMENT hands out max(sqlite_sequence.seq, max(rowid)) + 1.
            unassignedId = Math.max(before.sqliteSequence.companies ?? 0, maxId) + 1;
            const rows = [...companies.rows, unassignedRow(companies.columns, unassignedId)];
            tables.companies = { columns: companies.columns, rows, digest: digestOf(companies.columns, rows) };
            counts.companies = (before.counts.companies ?? 0) + 1;
            sequence.companies = unassignedId;
        }
    }

    const sessions = before.tables.work_sessions;
    if (sessions !== null && unassignedId !== null) {
        const companyAt = cellIndex(sessions.columns, 'company_id');
        if (companyAt !== -1) {
            const adopted = String(unassignedId);
            const rows = sessions.rows.map((row) =>
                row[companyAt] === 'NULL' ? row.map((cell, at) => (at === companyAt ? adopted : cell)) : row);
            tables.work_sessions = { columns: sessions.columns, rows, digest: digestOf(sessions.columns, rows) };
        }
    }

    let settings = before.settings;
    const settingsTable = before.tables.settings;
    if (settings !== null) {
        const predicted: Record<string, string> = { ...settings };
        for (const [key, value] of V121_DEFAULT_SETTINGS) {
            // INSERT OR IGNORE: an existing key keeps the user's value.
            if (!(key in predicted)) predicted[key] = value;
        }
        settings = predicted;
        counts.settings = Object.keys(predicted).length;
        if (settingsTable !== null) {
            const columns = settingsTable.columns;
            const keyAt = cellIndex(columns, 'key');
            const valueAt = cellIndex(columns, 'value');
            const rows = Object.keys(predicted).sort().map((key) => columns.map((column, at) => {
                if (at === keyAt) return quoteText(key);
                if (at === valueAt) return quoteText(predicted[key] ?? '');
                return 'NULL';
            }));
            tables.settings = { columns, rows, digest: digestOf(columns, rows) };
        }
    }

    return {
        tables,
        counts,
        totalDuration: before.totalDuration,
        sqliteSequence: sequence,
        settings,
        dayTotals: before.dayTotals
    };
}

const sameCell = (expected: string, actual: string): boolean =>
    expected === actual || (expected === TIMESTAMP_SENTINEL && TIMESTAMP_TEXT.test(actual));

function diffTable(table: string, expected: TableInvariant, actual: TableInvariant): string[] {
    const differences: string[] = [];
    if (expected.columns.join(',') !== actual.columns.join(',')) {
        differences.push(table + ': the digested column list changed');
        return differences;
    }
    if (expected.rows.length !== actual.rows.length) {
        differences.push(table + ': holds ' + String(actual.rows.length) + ' rows, expected ' +
            String(expected.rows.length));
        return differences;
    }
    let changed = 0;
    const columns = new Set<string>();
    expected.rows.forEach((row, index) => {
        const other = actual.rows[index] ?? [];
        row.forEach((cell, at) => {
            if (sameCell(cell, other[at] ?? '')) return;
            changed += 1;
            columns.add(expected.columns[at] ?? String(at));
        });
    });
    if (changed > 0) {
        differences.push(table + ': ' + String(changed) + ' cell(s) differ, in column(s) ' +
            [...columns].sort().join(', '));
    }
    return differences;
}

// Names tables, counts and column names only - never a row value (T-01-37).
export function diffInvariants(expected: DatabaseInvariants, actual: DatabaseInvariants): string[] {
    const differences: string[] = [];

    for (const table of INVARIANT_TABLES) {
        const want = expected.tables[table];
        // A table absent before the migration has nothing to preserve; the oracle covers its creation.
        if (want === null) continue;
        const got = actual.tables[table];
        if (got === null) {
            differences.push(table + ': the table is gone');
            continue;
        }
        differences.push(...diffTable(table, want, got));
        if (expected.counts[table] !== actual.counts[table]) {
            differences.push(table + ': count is ' + String(actual.counts[table]) + ', expected ' +
                String(expected.counts[table]));
        }
    }

    if (expected.totalDuration !== actual.totalDuration) {
        differences.push('work_sessions sum(duration) is ' + String(actual.totalDuration) + ', expected ' +
            String(expected.totalDuration));
    }

    for (const [name, seq] of Object.entries(expected.sqliteSequence)) {
        if (actual.sqliteSequence[name] !== seq) {
            differences.push('sqlite_sequence.' + name + ' is ' + String(actual.sqliteSequence[name]) +
                ', expected ' + String(seq));
        }
    }

    if (expected.settings !== null) {
        const got = actual.settings;
        if (got === null) {
            differences.push('settings: the table is gone');
        } else {
            for (const [key, value] of Object.entries(expected.settings)) {
                if (got[key] !== value) differences.push('settings: key ' + key + ' does not hold its expected value');
            }
            for (const key of Object.keys(got)) {
                if (!(key in expected.settings)) differences.push('settings: unexpected key ' + key);
            }
        }
    }

    const days = new Set([...Object.keys(expected.dayTotals), ...Object.keys(actual.dayTotals)]);
    for (const day of days) {
        if (expected.dayTotals[day] !== actual.dayTotals[day]) {
            differences.push('day total for one date changed');
            break;
        }
    }

    return differences;
}

// v1.2.1's calculateCurrentStreak (database/db.js), recomputed from day totals with date.ts only.
export function streakOn(invariants: DatabaseInvariants, today: LocalDate): number {
    const settings = invariants.settings ?? {};
    const dailyTarget = Number.parseInt(settings.daily_target || V121_DEFAULT_TARGET, 10);
    const excludeWeekends = settings.exclude_weekends_from_streak === 'true';
    const totals = invariants.dayTotals;
    if (Object.keys(totals).length === 0) return 0;

    const reached = (day: LocalDate): boolean => {
        const total = totals[day];
        return total !== undefined && total >= dailyTarget;
    };

    let streak = 0;
    let check: LocalDate = reached(today) ? today : addDays(today, -1);
    // db.js stops after 365 days; the bound also makes this loop total.
    while (diffDays(today, check) <= 365) {
        if (excludeWeekends && isoWeekday(check) >= 6) {
            check = addDays(check, -1);
            continue;
        }
        if (!reached(check)) break;
        streak += 1;
        check = addDays(check, -1);
    }
    return streak;
}

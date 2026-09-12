// Row-to-domain mapping shared by the four repositories. A row that cannot become its domain object is left out of
// the result and reported by table, column and id - never by value, because a session name or note is user data.

import { epochMsFromSqlTimestamp, isLocalDate } from '@shared/utils/date';
import type { LocalDate } from '@shared/utils/date';

export interface SkippedRow {
    readonly table: string;
    readonly column: string;
    readonly rowId: number | null;
    readonly reason: string;
}

export interface RepositoryOptions {
    /**
     * Called once per row the mapper refused. Phase 4 counts these anomalies at migration and never repairs them
     * (D-15), so a repository that threw would brick the app for a database a third-party tool has edited, and one
     * that dropped them silently would hide it. The default drops and says nothing; the composition root supplies
     * the reporter.
     */
    readonly onSkippedRow?: (skipped: SkippedRow) => void;
}

export class RowMappingError extends Error {
    readonly column: string;

    constructor(column: string, reason: string) {
        super(column + ' ' + reason);
        this.name = 'RowMappingError';
        this.column = column;
    }
}

export function requireId(column: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new RowMappingError(column, 'is not a positive whole row id');
    }
    return value;
}

export function optionalId(column: string, value: unknown): number | null {
    return value === null || value === undefined ? null : requireId(column, value);
}

export function requireText(column: string, value: unknown): string {
    if (typeof value !== 'string') throw new RowMappingError(column, 'is not stored as text');
    return value;
}

export function optionalText(column: string, value: unknown): string | null {
    return value === null || value === undefined ? null : requireText(column, value);
}

export function requireLocalDate(column: string, value: unknown): LocalDate {
    if (!isLocalDate(value)) throw new RowMappingError(column, 'is not a YYYY-MM-DD local day');
    return value;
}

/** A stored CURRENT_TIMESTAMP as epoch milliseconds; the parse itself lives in date.ts (SHARED-03). */
export function requireEpochMs(column: string, value: unknown): number {
    if (typeof value !== 'string') throw new RowMappingError(column, 'is not stored as text');
    try {
        return epochMsFromSqlTimestamp(value);
    } catch {
        throw new RowMappingError(column, 'is not a UTC "YYYY-MM-DD HH:MM:SS"');
    }
}

export function requireWholeSeconds(column: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new RowMappingError(column, 'is not a whole non-negative number of seconds');
    }
    return value;
}

export function requireCount(column: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new RowMappingError(column, 'is not a whole non-negative count');
    }
    return value;
}

/** v1.2.1 writes 0 or 1 and its ALTER left the column nullable, so an absent flag reads as false. */
export function storedFlag(value: unknown): boolean {
    return value === 1 || value === true;
}

// Aggregate rows carry no id; a skip is then reported against the table alone.
function idOf(row: object): number | null {
    const id: unknown = (row as { id?: unknown }).id;
    return typeof id === 'number' ? id : null;
}

export function mapRows<R extends object, T>(
    table: string,
    rows: readonly R[],
    map: (row: R) => T,
    options: RepositoryOptions = {}
): T[] {
    const mapped: T[] = [];
    for (const row of rows) {
        try {
            mapped.push(map(row));
        } catch (error) {
            if (!(error instanceof RowMappingError)) throw error;
            options.onSkippedRow?.({ table, column: error.column, rowId: idOf(row), reason: error.message });
        }
    }
    return mapped;
}

export function mapRow<R extends object, T>(
    table: string,
    row: R | undefined,
    map: (row: R) => T,
    options: RepositoryOptions = {}
): T | null {
    if (row === undefined) return null;
    const mapped = mapRows(table, [row], map, options);
    return mapped[0] ?? null;
}

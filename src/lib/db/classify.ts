// Classifies a database from what a read-only probe observed, before anything writes to it (D-12).
// Pure and total: no I/O, never throws.

export type DbClass = 'fresh' | 'legacy' | 'unrecognized' | 'current-behind' | 'current' | 'newer';

export type V1xTable = 'companies' | 'work_sessions' | 'settings' | 'pomodoro_sessions';

// The CREATE TABLE columns of every v1.x table, from database/db.js history (D-14); ALTER columns come after them.
export const V1X_TABLE_PREFIXES: Readonly<Record<V1xTable, readonly string[]>> = Object.freeze({
    companies: Object.freeze(['id', 'name', 'created_at', 'updated_at']),
    work_sessions: Object.freeze(['id', 'name', 'duration', 'date', 'created_at']),
    settings: Object.freeze(['key', 'value']),
    pomodoro_sessions: Object.freeze(['id', 'date', 'company_id', 'pomodoros_completed', 'created_at'])
});

export const V1X_TABLES = Object.freeze(Object.keys(V1X_TABLE_PREFIXES) as V1xTable[]);

export interface ObservedDatabase {
    exists: boolean;
    userVersion: number;
    objects: readonly { type: string; name: string }[];
    // pragma_table_info names in cid order, for each v1.x table the file has.
    columns: Readonly<Partial<Record<V1xTable, readonly string[]>>>;
}

const isInternal = (name: string): boolean => name === 'sqlite_sequence' || name.startsWith('sqlite_autoindex_');

const isV1xTable = (name: string): name is V1xTable => (V1X_TABLES as readonly string[]).includes(name);

function startsWith(columns: readonly string[] | undefined, prefix: readonly string[]): boolean {
    return columns !== undefined && prefix.every((column, index) => columns[index] === column);
}

export function classify(observed: ObservedDatabase, latest: number): DbClass {
    if (!observed.exists) return 'fresh';
    const version = observed.userVersion;
    if (!Number.isSafeInteger(version) || version < 0) return 'unrecognized';
    if (version > latest) return 'newer';
    if (version === latest) return 'current';
    if (version >= 1) return 'current-behind';

    const userObjects = observed.objects.filter((object) => !isInternal(object.name));
    if (userObjects.length === 0) return 'fresh';

    const v1xTables = userObjects
        .filter((object) => object.type === 'table')
        .map((object) => object.name)
        .filter(isV1xTable);
    const anchored = v1xTables.includes('work_sessions') || v1xTables.includes('companies');
    const fingerprinted = v1xTables.every((table) => startsWith(observed.columns[table], V1X_TABLE_PREFIXES[table]));
    return anchored && fingerprinted ? 'legacy' : 'unrecognized';
}

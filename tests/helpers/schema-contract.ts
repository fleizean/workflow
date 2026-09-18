// D-27: one normalization for both sides of the schema contract, so real drift fails a test and nothing else does.
// Live shape comes from the pragma table-valued functions, never from parsing sqlite_master text.

import type DatabaseType from 'better-sqlite3';
import { is, SQL } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

export type Affinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC';

export interface NormalizedColumn {
    readonly affinity: Affinity;
    readonly notnull: boolean;
    readonly dflt: string | null;
    readonly pk: boolean;
}

export interface NormalizedTable {
    readonly name: string;
    readonly columns: Map<string, NormalizedColumn>;
    readonly columnOrder: readonly string[];
    // Each entry is a sorted, comma-joined column list: an inline UNIQUE equals a named unique index (rule 4).
    readonly uniques: Set<string>;
    readonly indexes: Map<string, readonly string[]>;
    // 'from>table.to:on_delete', on_delete lower-cased (rule 6).
    readonly fks: Set<string>;
}

interface XInfoRow {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    hidden: number;
}

interface IndexListRow { name: string; unique: number; origin: string }
interface IndexInfoRow { seqno: number; name: string | null }
interface ForeignKeyRow { table: string; from: string; to: string | null; on_delete: string }

// SQLite's five affinity rules, in order (sqlite.org/datatype3.html 3.1). DATETIME falls through to NUMERIC.
export function affinityOf(declaredType: string): Affinity {
    const type = declaredType.toUpperCase();
    if (type.includes('INT')) return 'INTEGER';
    if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'TEXT';
    if (type.includes('BLOB') || type === '') return 'BLOB';
    if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'REAL';
    return 'NUMERIC';
}

// Defaults are keywords or numbers here, so lower-casing the whole text is enough to make the two sides comparable.
function normalizeDefault(raw: string | null): string | null {
    if (raw === null) return null;
    let text = raw.trim();
    if (text.startsWith('(') && text.endsWith(')')) {
        text = text.slice(1, -1).trim();
    }
    return text.toLowerCase();
}

const uniqueKey = (columns: readonly string[]): string => [...columns].sort().join(',');

const fkKey = (from: string, table: string, to: string, onDelete: string): string =>
    from + '>' + table + '.' + to + ':' + onDelete.toLowerCase();

export function liveContract(db: DatabaseType.Database, tableName: string): NormalizedTable {
    const xinfo = db.prepare<[string], XInfoRow>('SELECT * FROM pragma_table_xinfo(?)').all(tableName);
    if (xinfo.length === 0) {
        throw new Error('schema-contract: the live database has no table ' + tableName);
    }

    const columns = new Map<string, NormalizedColumn>();
    const columnOrder: string[] = [];
    for (const column of xinfo) {
        columnOrder.push(column.name);
        columns.set(column.name, {
            affinity: affinityOf(column.type),
            notnull: column.notnull !== 0,
            dflt: normalizeDefault(column.dflt_value),
            pk: column.pk !== 0
        });
    }

    const uniques = new Set<string>();
    const indexes = new Map<string, readonly string[]>();
    const indexInfo = db.prepare<[string], IndexInfoRow>('SELECT * FROM pragma_index_info(?) ORDER BY seqno');
    for (const index of db.prepare<[string], IndexListRow>('SELECT * FROM pragma_index_list(?)').all(tableName)) {
        const indexColumns = indexInfo.all(index.name).map((row) => row.name ?? '<expression>');
        if (index.unique !== 0) {
            // origin 'pk' is the primary key's own autoindex, not a declared uniqueness constraint.
            if (index.origin !== 'pk') uniques.add(uniqueKey(indexColumns));
        } else {
            indexes.set(index.name, indexColumns);
        }
    }

    const fks = new Set<string>();
    for (const fk of db.prepare<[string], ForeignKeyRow>('SELECT * FROM pragma_foreign_key_list(?)').all(tableName)) {
        fks.add(fkKey(fk.from, fk.table, fk.to ?? '<pk>', fk.on_delete));
    }

    return { name: tableName, columns, columnOrder, uniques, indexes, fks };
}

function sqlDefaultText(value: SQL): string {
    return value.queryChunks.map((chunk) => {
        const parts = (chunk as { value?: unknown }).value;
        return Array.isArray(parts) ? parts.join('') : '';
    }).join('');
}

// A non-SQL default is a primitive here; anything else would stringify to '[object Object]' and compare as garbage.
function literalDefaultText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    throw new Error('schema-contract: cannot normalize a declared default of type ' + typeof value);
}

function namedColumn(column: unknown): string {
    const named = column as { name?: unknown };
    return typeof named.name === 'string' ? named.name : '<expression>';
}

export function declaredContract(table: SQLiteTable): NormalizedTable {
    const config = getTableConfig(table);

    const columns = new Map<string, NormalizedColumn>();
    const columnOrder: string[] = [];
    const uniques = new Set<string>();

    for (const column of config.columns) {
        columnOrder.push(column.name);
        // `hasDefault` is true for an autoincrement primary key that has no default value; read `default` itself.
        const declared: unknown = column.default;
        const dflt = declared === undefined
            ? null
            : normalizeDefault(is(declared, SQL) ? sqlDefaultText(declared) : literalDefaultText(declared));
        columns.set(column.name, {
            affinity: affinityOf(column.getSQLType()),
            notnull: column.notNull,
            dflt,
            pk: column.primary
        });
        // Every column carries a generated `uniqueName`; only `isUnique` says the constraint exists.
        if (column.isUnique) uniques.add(uniqueKey([column.name]));
    }

    for (const constraint of config.uniqueConstraints) {
        uniques.add(uniqueKey(constraint.columns.map((column) => column.name)));
    }

    const indexes = new Map<string, readonly string[]>();
    for (const index of config.indexes) {
        const indexColumns = (index.config.columns ?? []).map(namedColumn);
        if (index.config.unique === true) {
            uniques.add(uniqueKey(indexColumns));
        } else {
            indexes.set(index.config.name, indexColumns);
        }
    }

    const fks = new Set<string>();
    for (const fk of config.foreignKeys) {
        const reference = fk.reference();
        const target = getTableConfig(reference.foreignTable).name;
        reference.columns.forEach((column, at) => {
            const to = reference.foreignColumns[at]?.name ?? '<pk>';
            fks.add(fkKey(column.name, target, to, fk.onDelete ?? 'no action'));
        });
    }

    return { name: config.name, columns, columnOrder, uniques, indexes, fks };
}

const sortedNames = (table: NormalizedTable): string[] => [...table.columns.keys()].sort();

// Column attributes are compared by NAME after sorting, so declaration order alone can never fail this (edge 26).
export function compareContracts(live: NormalizedTable, declared: NormalizedTable): string[] {
    const differences: string[] = [];
    const where = live.name;

    for (const name of sortedNames(live)) {
        if (!declared.columns.has(name)) {
            differences.push(where + '.' + name + ': present in the database, absent from the declaration');
        }
    }
    for (const name of sortedNames(declared)) {
        if (!live.columns.has(name)) {
            differences.push(where + '.' + name + ': declared, absent from the database');
        }
    }

    for (const name of sortedNames(live)) {
        const liveColumn = live.columns.get(name);
        const declaredColumn = declared.columns.get(name);
        if (liveColumn === undefined || declaredColumn === undefined) continue;

        if (liveColumn.affinity !== declaredColumn.affinity) {
            differences.push(where + '.' + name + ': affinity ' + liveColumn.affinity + ' in the database, ' +
                declaredColumn.affinity + ' declared');
        }
        if (liveColumn.pk !== declaredColumn.pk) {
            differences.push(where + '.' + name + ': pk ' + String(liveColumn.pk) + ' in the database, ' +
                String(declaredColumn.pk) + ' declared');
        }
        // Rule 2: SQLite reports notnull 0 for a legacy PRIMARY KEY column while Drizzle reports NOT NULL.
        if (!liveColumn.pk && !declaredColumn.pk && liveColumn.notnull !== declaredColumn.notnull) {
            differences.push(where + '.' + name + ': notnull ' + String(liveColumn.notnull) + ' in the database, ' +
                String(declaredColumn.notnull) + ' declared');
        }
        if (liveColumn.dflt !== declaredColumn.dflt) {
            differences.push(where + '.' + name + ': default ' + String(liveColumn.dflt) + ' in the database, ' +
                String(declaredColumn.dflt) + ' declared');
        }
    }

    for (const key of [...live.uniques].sort()) {
        if (!declared.uniques.has(key)) {
            differences.push(where + ': unique (' + key + ') in the database, not declared');
        }
    }
    for (const key of [...declared.uniques].sort()) {
        if (!live.uniques.has(key)) {
            differences.push(where + ': unique (' + key + ') declared, absent from the database');
        }
    }

    for (const [name, columns] of [...live.indexes].sort()) {
        const declaredColumns = declared.indexes.get(name);
        if (declaredColumns === undefined) {
            differences.push(where + ': index ' + name + ' in the database, not declared');
        } else if (declaredColumns.join(',') !== columns.join(',')) {
            differences.push(where + ': index ' + name + ' covers (' + columns.join(',') + ') in the database, (' +
                declaredColumns.join(',') + ') declared');
        }
    }
    for (const name of [...declared.indexes.keys()].sort()) {
        if (!live.indexes.has(name)) {
            differences.push(where + ': index ' + name + ' declared, absent from the database');
        }
    }

    for (const key of [...live.fks].sort()) {
        if (!declared.fks.has(key)) {
            differences.push(where + ': foreign key ' + key + ' in the database, not declared');
        }
    }
    for (const key of [...declared.fks].sort()) {
        if (!live.fks.has(key)) {
            differences.push(where + ': foreign key ' + key + ' declared, absent from the database');
        }
    }

    return differences;
}

// Its own assertion, against the live order: a reordered declaration fails only this (research rule 7).
export function compareColumnOrder(live: NormalizedTable, declared: NormalizedTable): string[] {
    if (live.columnOrder.join(',') === declared.columnOrder.join(',')) return [];
    return [live.name + ': column order is (' + live.columnOrder.join(',') + ') in the database, (' +
        declared.columnOrder.join(',') + ') declared'];
}

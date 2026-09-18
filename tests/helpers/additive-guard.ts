// D-20's additive allowlist as test machinery: a tokenizer, a per-statement classifier, a semantic schema delta
// and a runtime-trace checker. Every layer fails closed and names rules, never row values.

import { createHash } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import { splitStatements } from '../../src/lib/db/runner';
import { V121_INIT } from './v121-sql';

export const V121_TABLES: readonly string[] = ['companies', 'work_sessions', 'settings', 'pomodoro_sessions'];

/*
 * V2-SCHEMA-01: the single exception to D-20, spelled by name rather than by shape. The Google Sheets export left
 * the app on 2026-09-11, and migration 0002 takes its four remnants out of the database. Nothing else widens with
 * it: every other DROP - of a column, a table or an index - is refused as before, and so is a DELETE of any row
 * but these two keys.
 */
export const RETIRED_COLUMNS: readonly string[] = ['companies.excel_column', 'companies.note_column'];
export const RETIRED_SETTINGS: readonly string[] = ['export_half_hour_precision', 'script_url'];

const SETTINGS_TABLE = 'settings';

const isRetiredColumn = (table: string, column: string): boolean =>
    RETIRED_COLUMNS.includes(table.toLowerCase() + '.' + column.toLowerCase());

export interface GuardContext {
    readonly v121Tables: readonly string[];
    readonly milestoneTables: readonly string[];
    readonly existingTables: readonly string[];
}

export type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'punct';

export interface Token {
    readonly kind: TokenKind;
    // Words are upper-cased; idents and strings carry their unquoted text.
    readonly value: string;
    readonly raw: string;
}

// Transaction and connection control belong to the runner, and no allowed statement contains these (D-07, D-20).
const FORBIDDEN_ANYWHERE: readonly string[] = [
    'DROP', 'RENAME', 'TRIGGER', 'VIEW',
    'PRAGMA', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'VACUUM', 'ATTACH', 'DETACH'
];

const CLOSING_QUOTE: Readonly<Record<string, string>> = { '"': '"', '`': '`', '[': ']' };

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isWordStart = (ch: string): boolean => (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
const isWordPart = (ch: string): boolean => isWordStart(ch) || isDigit(ch) || ch === '$';

export function tokenizeSql(sql: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < sql.length) {
        const ch = sql.charAt(i);
        if (isSpace(ch)) {
            i += 1;
            continue;
        }
        if (ch === '-' && sql.charAt(i + 1) === '-') {
            while (i < sql.length && sql.charAt(i) !== '\n') i += 1;
            continue;
        }
        if (ch === '/' && sql.charAt(i + 1) === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end === -1 ? sql.length : end + 2;
            continue;
        }
        if (ch === "'") {
            let j = i + 1;
            let value = '';
            while (j < sql.length) {
                if (sql.charAt(j) === "'" && sql.charAt(j + 1) === "'") {
                    value += "'";
                    j += 2;
                    continue;
                }
                if (sql.charAt(j) === "'") break;
                value += sql.charAt(j);
                j += 1;
            }
            tokens.push({ kind: 'string', value, raw: sql.slice(i, Math.min(j + 1, sql.length)) });
            i = j + 1;
            continue;
        }
        const closing = CLOSING_QUOTE[ch];
        if (closing !== undefined) {
            const end = sql.indexOf(closing, i + 1);
            const stop = end === -1 ? sql.length : end;
            tokens.push({ kind: 'ident', value: sql.slice(i + 1, stop), raw: sql.slice(i, stop + 1) });
            i = stop + 1;
            continue;
        }
        if (isDigit(ch)) {
            let j = i;
            while (j < sql.length && (isDigit(sql.charAt(j)) || sql.charAt(j) === '.')) j += 1;
            tokens.push({ kind: 'number', value: sql.slice(i, j), raw: sql.slice(i, j) });
            i = j;
            continue;
        }
        if (isWordStart(ch)) {
            let j = i;
            while (j < sql.length && isWordPart(sql.charAt(j))) j += 1;
            const raw = sql.slice(i, j);
            tokens.push({ kind: 'word', value: raw.toUpperCase(), raw });
            i = j;
            continue;
        }
        tokens.push({ kind: 'punct', value: ch, raw: ch });
        i += 1;
    }
    return tokens;
}

// Every literal collapses to `?`, so a trace with bound values expanded compares equal to its prepared form.
function normalize(sql: string): string {
    return tokenizeSql(sql)
        .map((token) => {
            if (token.kind === 'word') return token.value;
            if (token.kind === 'ident') return token.value.toUpperCase();
            if (token.kind === 'string' || token.kind === 'number') return '?';
            return token.value;
        })
        .join(' ');
}

interface NamedToken {
    readonly keyword: string | null;
    readonly name: string;
}

const namedTokens = (tokens: readonly Token[]): NamedToken[] =>
    tokens
        .filter((token) => token.kind === 'word' || token.kind === 'ident')
        .map((token) => ({
            keyword: token.kind === 'word' ? token.value : null,
            name: token.kind === 'word' ? token.raw : token.value
        }));

const headOf = (tokens: readonly Token[]): string =>
    tokens.filter((token) => token.kind === 'word').slice(0, 3).map((token) => token.value).join(' ');

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const inList = (list: readonly string[], name: string | null): boolean =>
    name !== null && list.some((entry) => sameName(entry, name));

// Tokens that carry meaning: a trailing statement terminator is not one.
const significant = (tokens: readonly Token[]): Token[] =>
    tokens.filter((token) => !(token.kind === 'punct' && token.value === ';'));

// The text of a name, however it was written: `companies`, "companies" and companies all read the same.
const nameOf = (token: Token | undefined): string | null => {
    if (token === undefined) return null;
    if (token.kind === 'ident') return token.value;
    return token.kind === 'word' ? token.raw : null;
};

/*
 * ALTER TABLE <table> DROP [COLUMN] <column>, and nothing else at all: exactly five or six name tokens, no
 * punctuation, both names on RETIRED_COLUMNS. Anything longer, or carrying a comma, a predicate or a second
 * column, falls through to the DROP refusal below.
 */
function retiredColumnDrop(tokens: readonly Token[]): string | null {
    const rest = significant(tokens);
    if (rest.some((token) => token.kind !== 'word' && token.kind !== 'ident')) return null;
    const spelledColumn = rest[4]?.kind === 'word' && rest[4].value === 'COLUMN';
    if (rest.length !== (spelledColumn ? 6 : 5)) return null;
    if (rest[0]?.value !== 'ALTER' || rest[1]?.value !== 'TABLE' || rest[3]?.value !== 'DROP') return null;
    if (rest[0].kind !== 'word' || rest[1].kind !== 'word' || rest[3].kind !== 'word') return null;
    const table = nameOf(rest[2]);
    const column = nameOf(rest[spelledColumn ? 5 : 4]);
    if (table === null || column === null || !isRetiredColumn(table, column)) return null;
    return table.toLowerCase() + '.' + column.toLowerCase();
}

/*
 * DELETE FROM settings WHERE key = '<retired key>', one key per statement: exactly seven tokens, the table and
 * the column fixed, the predicate a single equality against a literal on RETIRED_SETTINGS. An IN list, an OR, a
 * LIKE or any other table does not match, and DELETE has no other allowed form.
 */
function retiredSettingDelete(tokens: readonly Token[]): string | null {
    const rest = significant(tokens);
    if (rest.length !== 7) return null;
    const word = (token: Token | undefined, value: string): boolean => token?.kind === 'word' && token.value === value;
    if (!word(rest[0], 'DELETE') || !word(rest[1], 'FROM') || !word(rest[3], 'WHERE')) return null;
    if (nameOf(rest[2])?.toLowerCase() !== SETTINGS_TABLE) return null;
    if (nameOf(rest[4])?.toLowerCase() !== 'key') return null;
    if (!(rest[5]?.kind === 'punct' && rest[5].value === '=')) return null;
    const literal = rest[6];
    if (literal?.kind !== 'string' || !RETIRED_SETTINGS.includes(literal.value)) return null;
    return literal.value;
}

export type StatementKind =
    | 'create-table' | 'create-index' | 'add-column' | 'insert'
    | 'drop-retired-column' | 'delete-retired-setting'
    | 'other';

export interface Classification {
    readonly allowed: boolean;
    readonly kind: StatementKind;
    readonly head: string;
    readonly target: string | null;
    readonly reason: string | null;
}

export function classifyStatement(sql: string, ctx: GuardContext): Classification {
    const tokens = tokenizeSql(sql);
    const head = headOf(tokens);
    const named = namedTokens(tokens);

    const reject = (kind: StatementKind, reason: string, target: string | null = null): Classification =>
        ({ allowed: false, kind, head, target, reason });
    const accept = (kind: StatementKind, target: string | null): Classification =>
        ({ allowed: true, kind, head, target, reason: null });

    if (tokens.length === 0) {
        return reject('other', 'an empty statement');
    }

    // V2-SCHEMA-01, before the refusals below: the two named drops and the two named deletes, and only in the
    // exact shapes above. Everything the matchers do not recognise reaches the same rules it always did.
    const droppedColumn = retiredColumnDrop(tokens);
    if (droppedColumn !== null) {
        return accept('drop-retired-column', droppedColumn);
    }
    const deletedSetting = retiredSettingDelete(tokens);
    if (deletedSetting !== null) {
        return accept('delete-retired-setting', deletedSetting);
    }

    // A forbidden word as a KEYWORD only: the tokenizer already dropped comments and kept strings and
    // quoted identifiers out of the word stream.
    const forbidden = tokens.find((token) => token.kind === 'word' && FORBIDDEN_ANYWHERE.includes(token.value));
    if (forbidden !== undefined) {
        return reject('other', forbidden.value + ' is forbidden in a migration (D-07, D-20)');
    }

    if (named[0]?.keyword === 'CREATE' && named[1]?.keyword === 'TABLE') {
        let at = 2;
        if (named[2]?.keyword === 'IF' && named[3]?.keyword === 'NOT' && named[4]?.keyword === 'EXISTS') at = 5;
        const name = named[at]?.name ?? null;
        if (name === null) {
            return reject('create-table', 'a CREATE TABLE whose name cannot be read');
        }
        if (inList(ctx.existingTables, name)) {
            return reject('create-table', 'CREATE TABLE of a table that already exists', name);
        }
        return accept('create-table', name);
    }

    const unique = named[1]?.keyword === 'UNIQUE';
    const indexAt = unique ? 2 : 1;
    if (named[0]?.keyword === 'CREATE' && named[indexAt]?.keyword === 'INDEX') {
        let at = indexAt + 1;
        if (named[at]?.keyword === 'IF' && named[at + 1]?.keyword === 'NOT' && named[at + 2]?.keyword === 'EXISTS') {
            at += 3;
        }
        const indexName = named[at]?.name ?? null;
        const onAt = named.findIndex((token, position) => position > at && token.keyword === 'ON');
        const table = onAt === -1 ? null : (named[onAt + 1]?.name ?? null);
        if (indexName === null || table === null) {
            return reject('create-index', 'a CREATE INDEX whose name or table cannot be read');
        }
        if (unique && !inList(ctx.milestoneTables, table)) {
            return reject('create-index', 'a UNIQUE index on a table this milestone did not create', indexName);
        }
        return accept('create-index', indexName);
    }

    if (named[0]?.keyword === 'ALTER' && named[1]?.keyword === 'TABLE') {
        const table = named[2]?.name ?? null;
        const addAt = named.findIndex((token) => token.keyword === 'ADD');
        if (addAt === -1) {
            return reject('other', 'an ALTER TABLE that is not ADD COLUMN', table);
        }
        let columnAt = addAt + 1;
        if (named[columnAt]?.keyword === 'COLUMN') columnAt += 1;
        const column = named[columnAt]?.name ?? null;
        const keywords = named.slice(columnAt).map((token) => token.keyword);
        const notNull = keywords.some((keyword, position) => keyword === 'NOT' && keywords[position + 1] === 'NULL');
        const hasDefault = keywords.includes('DEFAULT');
        if (notNull && !hasDefault) {
            return reject('add-column', 'ADD COLUMN NOT NULL with no constant DEFAULT', column);
        }
        return accept('add-column', column);
    }

    if (named[0]?.keyword === 'INSERT') {
        const intoAt = named.findIndex((token) => token.keyword === 'INTO');
        const table = intoAt === -1 ? null : (named[intoAt + 1]?.name ?? null);
        if (table === null) {
            return reject('insert', 'an INSERT whose table cannot be read');
        }
        if (!inList(ctx.milestoneTables, table)) {
            return reject('insert', 'INSERT into a table this milestone did not create', table);
        }
        if (named.some((token) => token.keyword === 'SELECT')) {
            return reject('insert', 'INSERT ... SELECT copies rows (the rebuild shape)', table);
        }
        return accept('insert', table);
    }

    return reject('other', head + ' is not on the D-20 allowlist');
}

export interface GuardViolation {
    readonly statement: string;
    readonly rule: string;
}

export interface GuardResult {
    readonly ok: boolean;
    readonly violations: readonly GuardViolation[];
    readonly statements: readonly Classification[];
    readonly created: readonly string[];
}

// Inspects exactly the chunks the runner executes: splitStatements is the runner's own splitter.
export function checkMigrationSql(sql: string, ctx: GuardContext): GuardResult {
    const violations: GuardViolation[] = [];
    const statements: Classification[] = [];
    const created: string[] = [];
    const createdTables: string[] = [];
    let known = [...ctx.existingTables];

    const chunks = splitStatements(sql);
    for (const chunk of chunks) {
        const local: GuardContext = {
            v121Tables: ctx.v121Tables,
            milestoneTables: [...ctx.milestoneTables, ...createdTables],
            existingTables: known
        };
        const classification = classifyStatement(chunk, local);
        statements.push(classification);
        if (!classification.allowed) {
            violations.push({ statement: classification.head, rule: classification.reason ?? 'not allowed' });
            continue;
        }
        if (classification.kind === 'create-table' && classification.target !== null) {
            known = [...known, classification.target];
            createdTables.push(classification.target);
            created.push(classification.target);
        } else if (classification.kind === 'create-index' && classification.target !== null) {
            created.push(classification.target);
        }
    }

    // WR-09: this layer reads the statements the per-statement rules ACCEPTED. The old version keyed off DROP or
    // RENAME beside a rejected INSERT ... SELECT, both of which are refused above, so it could only ever restate a
    // verdict already reached - deleting it changed no outcome. What it can see on its own is a copy of rows the
    // allowlist lets through: CREATE TABLE ... AS SELECT reads as a plain create-table to classifyStatement, and
    // it is the first half of the rebuild shape D-20 exists to forbid.
    chunks.forEach((chunk, index) => {
        const classification = statements[index];
        if (classification === undefined || !classification.allowed) return;
        const copies = tokenizeSql(chunk).some((token) => token.kind === 'word' && token.value === 'SELECT');
        if (!copies) return;
        violations.push({
            statement: classification.head,
            rule: 'the rebuild shape: an accepted statement that still copies rows (D-20)'
        });
    });

    return { ok: violations.length === 0, violations, statements, created };
}

export interface ObjectInfo {
    readonly type: string;
    readonly name: string;
    readonly sql: string | null;
    readonly rootpage: number;
}

export interface ColumnInfo {
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
    readonly pk: number;
}

export interface IndexInfo {
    readonly name: string;
    readonly isUnique: number;
    readonly origin: string;
}

export interface SchemaSnapshot {
    readonly objects: readonly ObjectInfo[];
    readonly columns: Readonly<Record<string, readonly ColumnInfo[]>>;
    readonly indexes: Readonly<Record<string, readonly IndexInfo[]>>;
    readonly digests: Readonly<Record<string, string>>;
    /** The same digest over the projection the sheets retirement leaves behind, so what survives it is comparable. */
    readonly retirementDigests: Readonly<Record<string, string>>;
    /** What RETIRED_COLUMNS and RETIRED_SETTINGS name that this table still holds: columns for one, keys for the other. */
    readonly retired: Readonly<Record<string, readonly string[]>>;
}

// A row with everything the retirement removes taken out; null when the row IS one of the retired settings.
function retirementProjection(table: string, row: Record<string, unknown>): Record<string, unknown> | null {
    if (table === SETTINGS_TABLE && typeof row.key === 'string' && RETIRED_SETTINGS.includes(row.key)) return null;
    const kept: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
        if (isRetiredColumn(table, column)) continue;
        kept[column] = value;
    }
    return kept;
}

export function snapshotSchema(db: DatabaseType.Database): SchemaSnapshot {
    const objects = db.prepare<[], ObjectInfo>(
        'SELECT type, name, sql, rootpage FROM sqlite_master ORDER BY type, name'
    ).all();
    const tables = objects.filter((object) => object.type === 'table').map((object) => object.name);

    const columns: Record<string, readonly ColumnInfo[]> = {};
    const indexes: Record<string, readonly IndexInfo[]> = {};
    for (const table of tables) {
        columns[table] = db.prepare<[string], ColumnInfo>(
            'SELECT name, type, "notnull" AS "notnull", dflt_value, pk FROM pragma_table_xinfo(?)'
        ).all(table);
        indexes[table] = db.prepare<[string], IndexInfo>(
            'SELECT name, "unique" AS isUnique, origin FROM pragma_index_list(?)'
        ).all(table);
    }

    const digests: Record<string, string> = {};
    const retirementDigests: Record<string, string> = {};
    const retired: Record<string, string[]> = {};
    for (const table of V121_TABLES) {
        const stillThere: string[] = [];
        retired[table] = stillThere;
        if (!tables.includes(table)) {
            digests[table] = 'absent';
            retirementDigests[table] = 'absent';
            continue;
        }
        for (const column of columns[table] ?? []) {
            if (isRetiredColumn(table, column.name)) stillThere.push(column.name);
        }
        const whole = createHash('sha256');
        const surviving = createHash('sha256');
        // `table` is one of V121_TABLES, a module constant, never caller input (T-01-35).
        const rows = db.prepare<[], Record<string, unknown>>('SELECT * FROM "' + table + '" ORDER BY rowid').iterate();
        for (const row of rows) {
            whole.update(JSON.stringify(row));
            const kept = retirementProjection(table, row);
            if (kept === null) {
                stillThere.push(String(row.key));
                continue;
            }
            surviving.update(JSON.stringify(kept));
        }
        digests[table] = whole.digest('hex');
        retirementDigests[table] = surviving.digest('hex');
    }

    return { objects, columns, indexes, digests, retirementDigests, retired };
}

export interface DeltaViolation {
    readonly rule: string;
    readonly object: string;
}

function tableOfIndex(snapshot: SchemaSnapshot, indexName: string): string | null {
    for (const [table, list] of Object.entries(snapshot.indexes)) {
        if (list.some((entry) => entry.name === indexName)) return table;
    }
    return null;
}

const sameColumn = (a: ColumnInfo, b: ColumnInfo | undefined): boolean =>
    b !== undefined && a.name === b.name && a.type === b.type && a.notnull === b.notnull &&
    a.dflt_value === b.dflt_value && a.pk === b.pk;

// V2-SCHEMA-01: true only when a table lost columns RETIRED_COLUMNS names and every survivor kept its place, its
// type, its nullability, its default and its key role. A rebuild that also retyped or reordered a column fails here.
function onlyRetiredColumnsRemoved(before: SchemaSnapshot, after: SchemaSnapshot, table: string): boolean {
    const had = before.columns[table];
    const has = after.columns[table];
    if (had === undefined || has === undefined) return false;
    const gone = had.filter((column) => !has.some((kept) => kept.name === column.name));
    if (gone.length === 0 || !gone.every((column) => isRetiredColumn(table, column.name))) return false;
    const survivors = had.filter((column) => !gone.includes(column));
    return survivors.length === has.length && survivors.every((column, index) => sameColumn(column, has[index]));
}

// V2-SCHEMA-01: the content moved, and the retirement is the whole of why. It must have taken something it names
// out - so a table that lost nothing retired cannot use this door - taken nothing it does not name, and left every
// row and column that survives its projection byte-identical.
function retirementExplains(before: SchemaSnapshot, after: SchemaSnapshot, table: string): boolean {
    if (before.retirementDigests[table] !== after.retirementDigests[table]) return false;
    const had = before.retired[table] ?? [];
    const left = after.retired[table] ?? [];
    return had.length > left.length && left.every((name) => had.includes(name));
}

// Accepts only D-20's deltas, so a rebuild is caught however it is spelled (the sql or the rootpage moves).
export function checkAllowedDelta(
    before: SchemaSnapshot,
    after: SchemaSnapshot,
    ctx: GuardContext
): DeltaViolation[] {
    const violations: DeltaViolation[] = [];
    const beforeByName = new Map(before.objects.map((object) => [object.name, object]));
    const afterByName = new Map(after.objects.map((object) => [object.name, object]));

    for (const [name, object] of beforeByName) {
        const now = afterByName.get(name);
        if (now === undefined) {
            violations.push({ rule: 'an object disappeared', object: name });
            continue;
        }
        if (now.sql !== object.sql && !onlyRetiredColumnsRemoved(before, after, name)) {
            violations.push({ rule: 'an object definition changed', object: name });
        }
        if (now.rootpage !== object.rootpage) {
            violations.push({ rule: 'an object was rebuilt (its rootpage moved)', object: name });
        }
    }

    const newObjects = [...afterByName.values()].filter((object) => !beforeByName.has(object.name));
    const newTables = newObjects.filter((object) => object.type === 'table').map((object) => object.name);

    for (const object of newObjects) {
        if (object.type === 'table') continue;
        if (object.type === 'index') {
            const table = tableOfIndex(after, object.name);
            if (object.name.startsWith('sqlite_autoindex_')) {
                // An autoindex is allowed only as part of a table this migration created.
                if (table === null || !inList(newTables, table)) {
                    violations.push({ rule: 'a new implicit unique index on an existing table', object: object.name });
                }
                continue;
            }
            const info = table === null ? undefined : after.indexes[table]?.find((entry) => entry.name === object.name);
            if (info?.isUnique === 1 && !inList([...ctx.milestoneTables, ...newTables], table)) {
                violations.push({ rule: 'a UNIQUE index on a table this milestone did not create', object: object.name });
            }
            continue;
        }
        violations.push({ rule: 'a new ' + object.type + ' is not additive (D-20)', object: object.name });
    }

    for (const [table, columns] of Object.entries(after.columns)) {
        const previous = before.columns[table];
        if (previous === undefined) continue;
        for (const column of columns) {
            if (previous.some((entry) => entry.name === column.name)) continue;
            if (column.notnull === 1 && column.dflt_value === null) {
                violations.push({ rule: 'a new NOT NULL column with no default', object: table + '.' + column.name });
            }
        }
    }

    for (const table of ctx.v121Tables) {
        if (before.digests[table] === after.digests[table]) continue;
        if (retirementExplains(before, after, table)) continue;
        violations.push({ rule: 'the content of a v1.2.1 table changed', object: table });
    }

    return violations;
}

// The runner's own statements, by exact normalized form.
const RUNNER_FORMS: ReadonlySet<string> = new Set([
    'PRAGMA FOREIGN_KEYS = ON',
    'PRAGMA FOREIGN_KEYS',
    'PRAGMA BUSY_TIMEOUT = ?',
    'PRAGMA JOURNAL_MODE = WAL',
    'PRAGMA USER_VERSION',
    'PRAGMA FOREIGN_KEY_CHECK',
    'PRAGMA WAL_CHECKPOINT ( TRUNCATE )',
    'PRAGMA INTEGRITY_CHECK'
]);

const VERSION_BUMP = 'PRAGMA USER_VERSION = ?';
const BASELINE_FORMS: ReadonlySet<string> = new Set(V121_INIT.map((entry) => normalize(entry.sql)));

const isRunnerStatement = (normalized: string): boolean =>
    RUNNER_FORMS.has(normalized) || normalized === VERSION_BUMP;

interface Segment {
    version: number | null;
    statements: string[];
}

// Segments a verbose trace by BEGIN IMMEDIATE ... COMMIT, labels each by its user_version write, and holds
// segment 1 to the D-13 statements and segments 2+ to D-20 (research Pattern 8 layer 3).
export function checkRuntimeTrace(trace: readonly string[], ctx: GuardContext): string[] {
    const violations: string[] = [];
    const segments: Segment[] = [];
    let current: Segment | null = null;

    for (const raw of trace) {
        const normalized = normalize(raw);
        if (normalized === 'BEGIN IMMEDIATE') {
            current = { version: null, statements: [] };
            segments.push(current);
            continue;
        }
        if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
            current = null;
            continue;
        }
        if (current === null) {
            if (RUNNER_FORMS.has(normalized)) continue;
            if (tokenizeSql(raw).find((token) => token.kind === 'word')?.value === 'SELECT') continue;
            violations.push('outside any transaction: ' + headOf(tokenizeSql(raw)) + ' - only the runner\'s own ' +
                'reads and connection pragmas may run outside a segment');
            continue;
        }
        if (normalized === VERSION_BUMP) {
            const number = tokenizeSql(raw).find((token) => token.kind === 'number');
            current.version = number === undefined ? null : Number(number.value);
            continue;
        }
        current.statements.push(raw);
    }

    segments.forEach((segment, index) => {
        const label = 'segment ' + String(index + 1);
        if (segment.version === null) {
            violations.push(label + ' commits without writing PRAGMA user_version');
        }
        if (segment.version === 1) {
            for (const raw of segment.statements) {
                const normalized = normalize(raw);
                if (isRunnerStatement(normalized)) continue;
                if (tokenizeSql(raw).find((token) => token.kind === 'word')?.value === 'SELECT') continue;
                if (!BASELINE_FORMS.has(normalized)) {
                    violations.push(label + ': ' + headOf(tokenizeSql(raw)) +
                        ' - not one of the enumerated D-13 baseline statements');
                }
            }
            return;
        }
        const applied = segment.statements.filter((raw) => {
            const normalized = normalize(raw);
            if (isRunnerStatement(normalized)) return false;
            return tokenizeSql(raw).find((token) => token.kind === 'word')?.value !== 'SELECT';
        });
        const result = checkMigrationSql(applied.join('\n--> statement-breakpoint\n'), ctx);
        for (const violation of result.violations) {
            violations.push(label + ': ' + violation.statement + ' - ' + violation.rule);
        }
    });

    return violations;
}

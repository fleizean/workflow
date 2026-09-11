// D-27/DATA-16: the database the runner produces is the one schema.ts declares, proven under one normalization.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { is, sql } from 'drizzle-orm';
import { index, integer, SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase, splitStatements } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import * as schema from '../src/lib/db/schema';
import type { AppStateRow } from '../src/lib/db/schema';
import { cleanupFixtures, copyFixture } from './fixtures/seed';
import { LEGACY_CORPUS, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
import { executeV121Init } from './helpers/v121-sql';
import { findAll, read, repoRoot, scriptKindFor } from './helpers/ts-imports';
import {
    affinityOf,
    compareColumnOrder,
    compareContracts,
    declaredContract,
    liveContract
} from './helpers/schema-contract';
import type { NormalizedTable } from './helpers/schema-contract';

const EXPECTED_TABLES = ['app_state', 'companies', 'pomodoro_sessions', 'settings', 'work_sessions'];

// The four tables v1.2.1 itself creates; app_state arrives with v2.
const V121_TABLES = ['companies', 'pomodoro_sessions', 'settings', 'work_sessions'];

const BASELINE_SQL = path.join(repoRoot, 'src', 'lib', 'db', 'migrations', '0000_v121_baseline.sql');

// DATA-11: name -> [table, column]. None is UNIQUE and each covers exactly its declared column.
const HISTORY_INDEXES: readonly (readonly [string, string, string])[] = [
    ['work_sessions_date_idx', 'work_sessions', 'date'],
    ['work_sessions_company_id_idx', 'work_sessions', 'company_id'],
    ['pomodoro_sessions_date_idx', 'pomodoro_sessions', 'date']
];

// Every table schema.ts exports, so a table added there is covered without editing this list.
const DECLARED: readonly NormalizedTable[] = Object.values(schema)
    .filter((value) => is(value, SQLiteTable))
    .map((table) => declaredContract(table));

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-contract-' + tag + '-'));
    tempDirs.push(dir);
    return dir;
}

afterAll(() => {
    cleanupFixtures();
    cleanupLegacyFixtures();
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Probes and classifies exactly as startup will: the production registry and the real D-13 replay run.
async function migrateAt(dbPath: string): Promise<void> {
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    const db = openDatabase(dbPath);
    try {
        await migrateDatabase(db, {
            dbPath,
            dbClass: classify(probe.observed, LATEST),
            fromVersion: probe.observed.userVersion,
            backupDir: path.join(path.dirname(dbPath), 'backups')
        });
    } finally {
        closeDatabase(db);
    }
}

async function migrateFresh(tag: string): Promise<string> {
    const dbPath = path.join(tempDir(tag), 'krono.db');
    await migrateAt(dbPath);
    return dbPath;
}

function contractsOf(dbPath: string, tables: readonly string[]): Map<string, NormalizedTable> {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return new Map(tables.map((name) => [name, liveContract(db, name)]));
    } finally {
        db.close();
    }
}

// A missing contract is a failed proof, never a skipped one.
function required(contracts: ReadonlyMap<string, NormalizedTable>, name: string): NormalizedTable {
    const found = contracts.get(name);
    if (found === undefined) throw new Error('no contract for ' + name);
    return found;
}

function declaredFor(name: string): NormalizedTable {
    const found = DECLARED.find((table) => table.name === name);
    if (found === undefined) throw new Error(name + ' is not declared in schema.ts');
    return found;
}

describe('D-27/DATA-16: a fresh install equals the schema.ts declaration', () => {
    let fresh: string;
    let live: Map<string, NormalizedTable>;

    beforeAll(async () => {
        fresh = await migrateFresh('fresh');
        live = contractsOf(fresh, EXPECTED_TABLES);
    }, 60_000);

    it('declares exactly the five tables this contract covers', () => {
        expect(DECLARED.map((table) => table.name).sort()).toEqual(EXPECTED_TABLES);
    });

    it.each(EXPECTED_TABLES)('%s matches the declaration under the D-27 normalization', (name) => {
        expect(compareContracts(required(live, name), declaredFor(name))).toEqual([]);
    });

    it.each(EXPECTED_TABLES)('%s declares its columns in the live order', (name) => {
        expect(compareColumnOrder(required(live, name), declaredFor(name))).toEqual([]);
    });

    it('app_state passes the contract with zero rows, and still yields a row type', () => {
        const db = new Database(fresh, { readonly: true, fileMustExist: true });
        try {
            const counted = db.prepare<[], { c: number }>('SELECT count(*) AS c FROM app_state').get();
            expect(counted?.c, 'a fresh install creates app_state empty').toBe(0);
        } finally {
            db.close();
        }

        const row: AppStateRow = { key: 'k', value: 'v', updated_at: '2026-01-01 00:00:00' };
        expect(row.key).toBe('k');
    });

    it('compares affinity, not declared text: DATETIME is NUMERIC (SQLite rule 5)', () => {
        expect(affinityOf('DATETIME')).toBe('NUMERIC');
        expect(affinityOf('INTEGER')).toBe('INTEGER');
        expect(affinityOf('text')).toBe('TEXT');
        expect(affinityOf('')).toBe('BLOB');
        expect(affinityOf('DOUBLE')).toBe('REAL');
    });
});

describe('D-27/DATA-16 + DATA-11: every adopted corpus fixture reaches that same schema', () => {
    const adopted = new Map<string, Map<string, NormalizedTable>>();
    let fresh: Map<string, NormalizedTable>;

    beforeAll(async () => {
        fresh = contractsOf(await migrateFresh('adopted-baseline'), EXPECTED_TABLES);
        for (const entry of LEGACY_CORPUS) {
            const fixture = copyFixture(await entry.build());
            await migrateAt(fixture);
            adopted.set(entry.id, contractsOf(fixture, EXPECTED_TABLES));
        }
    }, 900_000);

    it.each(LEGACY_CORPUS.map((entry) => entry.id))(
        '%s matches the declaration for all five tables',
        (id) => {
            const live = adopted.get(id);
            expect(live, id + ' was not migrated').toBeDefined();
            if (live === undefined) return;
            for (const name of EXPECTED_TABLES) {
                expect(compareContracts(required(live, name), declaredFor(name)), id + '/' + name).toEqual([]);
                expect(compareColumnOrder(required(live, name), declaredFor(name)), id + '/' + name).toEqual([]);
            }
        }
    );

    it('is table-for-table identical to a fresh install, pairwise', () => {
        expect(adopted.size, 'no fixture was migrated - the pairwise case proves nothing').toBe(LEGACY_CORPUS.length);
        for (const [id, live] of adopted) {
            for (const name of EXPECTED_TABLES) {
                expect(compareContracts(required(live, name), required(fresh, name)), id + '/' + name).toEqual([]);
                expect(compareColumnOrder(required(live, name), required(fresh, name)), id + '/' + name).toEqual([]);
            }
        }
    });

    it('carries the three history indexes, non-unique and on their declared columns, fresh and adopted', () => {
        const check = (label: string, contracts: ReadonlyMap<string, NormalizedTable>): void => {
            for (const [indexName, table, column] of HISTORY_INDEXES) {
                // liveContract files a UNIQUE index under `uniques`, so presence here IS the non-unique assertion.
                const columns = required(contracts, table).indexes.get(indexName);
                expect(columns, label + ': ' + indexName + ' is missing or unique').toBeDefined();
                expect(columns, label + ': ' + indexName).toEqual([column]);
            }
        };

        check('fresh', fresh);
        for (const [id, live] of adopted) {
            check(id, live);
        }
    });
});

describe('D-27: schema.ts describes the v1.2.1 shape truthfully', () => {
    it('drizzle\'s own 0000 baseline on an empty database equals the D-13 replay', () => {
        const generated = path.join(tempDir('generated'), 'krono.db');
        const replayed = path.join(tempDir('replayed'), 'krono.db');

        let db = openDatabase(generated);
        try {
            db.transaction(() => {
                for (const chunk of splitStatements(fs.readFileSync(BASELINE_SQL, 'utf8'))) {
                    db.prepare(chunk).run();
                }
            }).immediate();
        } finally {
            closeDatabase(db);
        }

        db = openDatabase(replayed);
        try {
            executeV121Init(db);
        } finally {
            closeDatabase(db);
        }

        const fromGenerated = contractsOf(generated, V121_TABLES);
        const fromReplay = contractsOf(replayed, V121_TABLES);
        for (const name of V121_TABLES) {
            expect(compareContracts(required(fromGenerated, name), required(fromReplay, name)), name).toEqual([]);
            expect(compareColumnOrder(required(fromGenerated, name), required(fromReplay, name)), name).toEqual([]);
        }
    }, 60_000);
});

// A negative control never edits schema.ts: it drifts a scratch database or declares its table locally.
describe('D-27 negative controls: drift fails the contract in every direction that matters', () => {
    it('an extra column added by ALTER fails, naming that column', async () => {
        const dbPath = await migrateFresh('extra-column');
        const db = openDatabase(dbPath);
        try {
            db.exec('ALTER TABLE work_sessions ADD COLUMN stray_column TEXT');
        } finally {
            closeDatabase(db);
        }

        const live = required(contractsOf(dbPath, ['work_sessions']), 'work_sessions');
        const differences = compareContracts(live, declaredFor('work_sessions'));

        expect(differences.join(' | '))
            .toContain('work_sessions.stray_column: present in the database, absent from the declaration');
    }, 60_000);

    it('companies.note_required declared text() fails on affinity', async () => {
        // The same seven columns in the same order; only note_required's declared type moves.
        const drifted = sqliteTable('companies', {
            id: integer('id').primaryKey({ autoIncrement: true }),
            name: text('name').notNull().unique(),
            created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
            updated_at: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
            excel_column: text('excel_column'),
            note_column: text('note_column'),
            note_required: text('note_required').default('0')
        });

        const dbPath = await migrateFresh('drifted-companies');
        const live = required(contractsOf(dbPath, ['companies']), 'companies');
        const differences = compareContracts(live, declaredContract(drifted));

        expect(differences.join(' | '))
            .toContain('companies.note_required: affinity INTEGER in the database, TEXT declared');
    }, 60_000);

    it('pomodoro_sessions.created_at declared text() fails against the live DATETIME', async () => {
        const drifted = sqliteTable('pomodoro_sessions', {
            id: integer('id').primaryKey({ autoIncrement: true }),
            date: text('date').notNull(),
            company_id: integer('company_id').references(() => schema.companies.id, { onDelete: 'cascade' }),
            pomodoros_completed: integer('pomodoros_completed').default(1),
            created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`)
        }, (t) => [index('pomodoro_sessions_date_idx').on(t.date)]);

        const dbPath = await migrateFresh('drifted-pomodoro');
        const live = required(contractsOf(dbPath, ['pomodoro_sessions']), 'pomodoro_sessions');
        const differences = compareContracts(live, declaredContract(drifted));

        expect(differences.join(' | '))
            .toContain('pomodoro_sessions.created_at: affinity NUMERIC in the database, TEXT declared');
    }, 60_000);

    it('a dropped index fails', async () => {
        const dbPath = await migrateFresh('dropped-index');
        const db = openDatabase(dbPath);
        try {
            db.exec('DROP INDEX work_sessions_date_idx');
        } finally {
            closeDatabase(db);
        }

        const live = required(contractsOf(dbPath, ['work_sessions']), 'work_sessions');
        const differences = compareContracts(live, declaredFor('work_sessions'));

        expect(differences.join(' | '))
            .toContain('work_sessions: index work_sessions_date_idx declared, absent from the database');
    }, 60_000);
});

const gitKnownFiles = (): string[] =>
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: repoRoot,
        encoding: 'utf8'
    })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

const sourceOf = (file: string): ts.SourceFile =>
    ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, scriptKindFor(file));

// `typeof companies.$inferSelect` / `$inferInsert` - the only sanctioned way to name a row.
function isDerivedRowType(type: ts.TypeNode): boolean {
    if (!ts.isTypeQueryNode(type)) return false;
    const name = type.exprName;
    return ts.isQualifiedName(name) && (name.right.text === '$inferSelect' || name.right.text === '$inferInsert');
}

function isQueryResult(expression: ts.Expression): boolean {
    if (!ts.isCallExpression(expression)) return false;
    const callee = expression.expression;
    return ts.isPropertyAccessExpression(callee) && (callee.name.text === 'get' || callee.name.text === 'all');
}

describe('DATA-14/D-11: row types are derived once, and drizzle stays out of src/shared', () => {
    it('no hand-written Row type and no assertion over a query result under src/lib/db', () => {
        const files = gitKnownFiles().filter((file) => file.startsWith('src/lib/db/') && file.endsWith('.ts'));
        expect(files.length, 'the scan found no files to read').toBeGreaterThan(0);

        const offenders: string[] = [];
        let derived = 0;

        for (const file of files) {
            const source = sourceOf(file);
            for (const alias of findAll(source, ts.isTypeAliasDeclaration)) {
                if (!alias.name.text.endsWith('Row')) continue;
                if (isDerivedRowType(alias.type)) {
                    derived += 1;
                } else {
                    offenders.push(file + ': type ' + alias.name.text + ' is not $inferSelect/$inferInsert');
                }
            }
            for (const declaration of findAll(source, ts.isInterfaceDeclaration)) {
                if (declaration.name.text.endsWith('Row')) {
                    offenders.push(file + ': interface ' + declaration.name.text + ' is hand-written');
                }
            }
            for (const assertion of findAll(source, ts.isAsExpression)) {
                if (isQueryResult(assertion.expression)) {
                    offenders.push(file + ': an `as` assertion over a .get()/.all() result');
                }
            }
        }

        expect(derived, 'no derived Row type was found - the scan would pass vacuously').toBeGreaterThan(0);
        expect(offenders).toEqual([]);
    });

    it('src/shared imports nothing from drizzle-orm, not even a type', () => {
        const files = gitKnownFiles()
            .filter((file) => file.startsWith('src/shared/') && (file.endsWith('.ts') || file.endsWith('.tsx')));
        expect(files.length, 'the scan found no files to read').toBeGreaterThan(0);

        const offenders: string[] = [];
        for (const file of files) {
            const source = sourceOf(file);
            for (const node of source.statements) {
                const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
                    ? node.moduleSpecifier
                    : undefined;
                if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
                if (specifier.text === 'drizzle-orm' || specifier.text.startsWith('drizzle-orm/')) {
                    offenders.push(file + ': ' + specifier.text);
                }
            }
        }

        expect(offenders).toEqual([]);
    });
});

// D-16 (DATA-12): every connection the database layer opens issues foreign_keys = ON itself, proven by the statement
// trace because the value alone is the driver's compiled-in default. Plus the cascade, structural and privacy scans.

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import Database from 'better-sqlite3';
import {
    BUSY_TIMEOUT_MS,
    FOREIGN_KEYS_PRAGMA,
    assertForeignKeysOn,
    closeDatabase,
    openDatabase
} from '../src/lib/db/client';
import { findAll, read, repoRoot } from './helpers/ts-imports';
import { buildLegacyFixture, cleanupLegacyFixtures } from './fixtures/legacy-shapes';

// Restated, not built from the client's constants: the read-back sits between the two pragmas.
const OPENING = [
    'PRAGMA foreign_keys = ON',
    'PRAGMA foreign_keys',
    'PRAGMA busy_timeout = 5000',
    'PRAGMA journal_mode = WAL'
];

const DRIVER = 'better-sqlite3';
const ASSERT = 'assertForeignKeysOn';

const tempDirs: string[] = [];

function freshDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-connection-'));
    tempDirs.push(dir);
    return path.join(dir, 'krono.db');
}

afterAll(() => {
    cleanupLegacyFixtures();
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// The trace expands bound values, so it stays in memory and on synthetic fixtures only (T-01-37).
function traced(dbPath: string): { db: Database.Database; trace: string[] } {
    const trace: string[] = [];
    const db = openDatabase(dbPath, { verbose: (sql) => { trace.push(String(sql)); } });
    return { db, trace };
}

describe('D-16: foreign keys are asserted per connection, by statement', () => {
    it('issues foreign_keys = ON and busy_timeout before any other statement, outside a transaction', () => {
        expect(FOREIGN_KEYS_PRAGMA).toBe('foreign_keys = ON');
        expect(BUSY_TIMEOUT_MS).toBe(5000);

        const { db, trace } = traced(freshDbPath());
        try {
            expect(trace.slice(0, OPENING.length)).toEqual(OPENING);
            expect(trace.some((sql) => /^\s*BEGIN/i.test(sql))).toBe(false);
        } finally {
            closeDatabase(db);
        }
    });

    it('reads foreign_keys 1 on a raw driver connection that never issued it, so the value alone proves nothing', () => {
        const trace: string[] = [];
        const raw = new Database(freshDbPath(), { verbose: (sql) => { trace.push(String(sql)); } });
        try {
            expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
            expect(trace).toEqual(['PRAGMA foreign_keys']);
        } finally {
            raw.close();
        }
    });

    it.each(['fresh', 'A', 'B', 'C'] as const)('reads foreign_keys 1 and busy_timeout 5000 on a %s database', (kind) => {
        const db = openDatabase(kind === 'fresh' ? freshDbPath() : buildLegacyFixture(kind));
        try {
            expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
            expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
        } finally {
            closeDatabase(db);
        }
    });

    it('makes a second connection to the same file issue the pragma in its own trace', () => {
        const dbPath = buildLegacyFixture('C');
        const first = traced(dbPath);
        const second = traced(dbPath);
        try {
            expect(first.trace.slice(0, OPENING.length)).toEqual(OPENING);
            expect(second.trace.slice(0, OPENING.length)).toEqual(OPENING);
        } finally {
            closeDatabase(second.db);
            closeDatabase(first.db);
        }
    });

    it('throws, naming the connection and the observed value, when foreign keys cannot be switched on', () => {
        const raw = new Database(freshDbPath());
        try {
            raw.pragma('foreign_keys = OFF');
            raw.exec('BEGIN'); // inside a transaction the pragma is a no-op
            expect(() => assertForeignKeysOn(raw, 'probe connection')).toThrow(/probe connection[\s\S]*reads back 0/);
            raw.exec('ROLLBACK');
        } finally {
            raw.close();
        }
    });
});

describe('D-16: ON DELETE CASCADE on a connection opened by the client', () => {
    it('removes a deleted company\'s work_sessions and pomodoro_sessions rows', () => {
        const db = openDatabase(buildLegacyFixture('C'));
        try {
            const northwind = db.prepare<[], { id: number }>("SELECT id FROM companies WHERE name = 'Northwind Fixture'").get();
            if (northwind === undefined) throw new Error('the shape-C fixture has no Northwind company');
            const rowsOf = (table: 'work_sessions' | 'pomodoro_sessions'): number => {
                const row = db.prepare<[number], { v: number }>(
                    'SELECT count(*) AS v FROM ' + table + ' WHERE company_id = ?'
                ).get(northwind.id);
                if (row === undefined) throw new Error('count(*) returned no row');
                return row.v;
            };

            expect(rowsOf('work_sessions')).toBe(2);
            expect(rowsOf('pomodoro_sessions')).toBe(1);

            db.prepare('DELETE FROM companies WHERE id = ?').run(northwind.id);

            expect(rowsOf('work_sessions')).toBe(0);
            expect(rowsOf('pomodoro_sessions')).toBe(0);
            expect(db.prepare<[], { v: number }>('SELECT count(*) AS v FROM work_sessions').get()?.v).toBe(1);
        } finally {
            closeDatabase(db);
        }
    });
});

function sourceFileOf(file: string, source: string): ts.SourceFile {
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

// Tracked and untracked-but-not-ignored TypeScript files under `dir`, so a new module is scanned before its commit.
function repoFiles(dir: string): string[] {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', dir], {
        cwd: repoRoot,
        encoding: 'utf8'
    })
        .split('\n')
        .filter((file) => /\.(ts|mts|cts)$/.test(file));
}

function driverBindings(sourceFile: ts.SourceFile): Set<string> {
    const names = new Set<string>();
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== DRIVER) {
            continue;
        }
        const clause = statement.importClause;
        if (clause === undefined || clause.isTypeOnly) continue;
        if (clause.name !== undefined) names.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings === undefined) continue;
        if (ts.isNamespaceImport(bindings)) {
            names.add(bindings.name.text);
        } else {
            for (const element of bindings.elements) {
                if (!element.isTypeOnly) names.add(element.name.text);
            }
        }
    }
    return names;
}

// Driver handles (with or without `new`) whose enclosing function has no later assertForeignKeysOn call.
function unassertedConnections(file: string, source: string): { constructions: number; unasserted: string[] } {
    const sourceFile = sourceFileOf(file, source);
    const openers = driverBindings(sourceFile);
    const constructions = findAll(sourceFile, (node): node is ts.NewExpression | ts.CallExpression =>
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        ts.isIdentifier(node.expression) && openers.has(node.expression.text));

    const unasserted = constructions.filter((construction) => {
        let scope: ts.Node | undefined = construction.parent;
        while (scope !== undefined && !ts.isFunctionLike(scope)) scope = scope.parent;
        if (scope === undefined) return true;
        const asserts = findAll(scope, (node): node is ts.CallExpression =>
            ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === ASSERT &&
            node.getStart(sourceFile) > construction.getStart(sourceFile));
        return asserts.length === 0;
    });
    return {
        constructions: constructions.length,
        unasserted: unasserted.map((node) => file + ':' +
            String(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1) + ' ' +
            node.getText(sourceFile))
    };
}

describe('D-16: every database handle under src/lib/db asserts foreign keys for itself', () => {
    it('flags samples without the assertion and passes one with it (the scan is not vacuous)', () => {
        const bare = "import Database from 'better-sqlite3';\nexport function f(p: string) { return new Database(p); }\n";
        const called = "import Driver from 'better-sqlite3';\nexport function f(p: string) { return Driver(p); }\n";
        const early = "import Database from 'better-sqlite3';\nimport { assertForeignKeysOn } from './client';\n" +
            'export function f(p: string, d: Database.Database) { assertForeignKeysOn(d, p); return new Database(p); }\n';
        const good = "import Database from 'better-sqlite3';\nimport { assertForeignKeysOn } from './client';\n" +
            'export function f(p: string) { const db = new Database(p); assertForeignKeysOn(db, p); return db; }\n';

        expect(unassertedConnections('bare.ts', bare).unasserted).toHaveLength(1);
        expect(unassertedConnections('called.ts', called).unasserted).toHaveLength(1);
        expect(unassertedConnections('early.ts', early).unasserted).toHaveLength(1);
        expect(unassertedConnections('good.ts', good)).toEqual({ constructions: 1, unasserted: [] });
    });

    it('finds the client and backup connections, and each asserts foreign keys after construction', () => {
        const files = repoFiles('src/lib/db');
        expect(files).toEqual(expect.arrayContaining(['src/lib/db/client.ts', 'src/lib/db/backup.ts']));

        let constructions = 0;
        const unasserted: string[] = [];
        for (const file of files) {
            const result = unassertedConnections(file, read(file));
            constructions += result.constructions;
            unasserted.push(...result.unasserted);
        }
        expect(constructions, 'the scan found no driver handle to check').toBeGreaterThanOrEqual(3);
        expect(unasserted, 'a connection that does not assert foreign keys itself relies on a default (D-16)')
            .toEqual([]);
    });
});

const propertyNameText = (name: ts.PropertyName | undefined): string | undefined =>
    name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;

function consoleReferences(file: string, source: string): string[] {
    const sourceFile = sourceFileOf(file, source);
    // A member name or an object key spelled `console` is not the global.
    return findAll(sourceFile, (node): node is ts.Identifier =>
        ts.isIdentifier(node) && node.text === 'console' &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node))
        .map((node) => file + ':' + String(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1));
}

function verboseProperties(file: string, source: string): string[] {
    const sourceFile = sourceFileOf(file, source);
    return findAll(sourceFile, (node): node is ts.ObjectLiteralElementLike =>
        ts.isObjectLiteralElementLike(node) && ts.isObjectLiteralExpression(node.parent) &&
        propertyNameText(node.name) === 'verbose')
        .map((node) => file + ':' + String(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1));
}

describe('T-04-02: the statement trace never reaches a log', () => {
    it('recognises console use and a verbose property in samples (the scans are not vacuous)', () => {
        expect(consoleReferences('s.ts', 'console.log(1);\nconst c = console;\n')).toHaveLength(2);
        expect(consoleReferences('s.ts', 'const x = { console: 1 };\nx.console;\n')).toEqual([]);
        expect(verboseProperties('s.ts', 'open(p, { verbose: log });\nopen(p, { verbose });\n')).toHaveLength(2);
        expect(verboseProperties('s.ts', "open(p, { 'verbose': log });\n")).toHaveLength(1);
        expect(verboseProperties('s.ts', 'const verbose = 1;\nopen(p, { quiet: verbose });\n')).toEqual([]);
    });

    it('keeps console out of every src/lib/db module', () => {
        const files = repoFiles('src/lib/db');
        expect(files.length).toBeGreaterThan(0);
        expect(files.flatMap((file) => consoleReferences(file, read(file)))).toEqual([]);
    });

    it('passes no verbose property from any src/main module', () => {
        const files = repoFiles('src/main');
        expect(files).toEqual(expect.arrayContaining(['src/main/index.ts', 'src/main/smoke.ts']));
        expect(files.flatMap((file) => verboseProperties(file, read(file)))).toEqual([]);
    });
});

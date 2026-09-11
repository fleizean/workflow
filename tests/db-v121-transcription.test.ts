// D-13/D-26: the v1.2.1 transcription is pinned to database/db.js by AST, and replaying it on every v1.x shape
// reproduces the real v1.2.1 schema byte for byte.

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { findAll, repoRoot } from './helpers/ts-imports';
import { cleanupFixtures, copyFixture, schemaOf } from './fixtures/seed';
import { SHAPES, buildLegacyFixture, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
import type { LegacyShapeId } from './fixtures/legacy-shapes';
import {
    V121_DEFAULT_SETTINGS,
    V121_INIT,
    V121_STATEMENTS,
    executeV121Init,
    runV121Downgrade
} from './helpers/v121-sql';
import type { V121DowngradeResult } from './helpers/v121-sql';

const SHAPE_IDS: readonly LegacyShapeId[] = ['A', 'B', 'C'];
const DB_JS = path.join(repoRoot, 'database', 'db.js');
const REAL_SCHEMA = path.join(repoRoot, 'tests', 'fixtures', 'v121-real-schema.sql');
const DB_METHODS: readonly string[] = ['exec', 'prepare', 'pragma'];
const TODAY = '2026-01-05';

// D-13/D-26: when Phase 7 deletes db.js the comparison cannot run, and a SHA-256 pin must replace it.
const PHASE_7_NOTE =
    'database/db.js is absent, so the transcription can no longer be pinned to its source. Phase 7 must ' +
    'replace this comparison with a SHA-256 pin of tests/helpers/v121-sql.ts in the same change that ' +
    'deletes the file (D-13, D-26).';

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-v121-' + tag + '-'));
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

function parseDbJs(): ts.SourceFile {
    const source = fs.readFileSync(DB_JS, 'utf8');
    return ts.createSourceFile('db.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

// Every string or no-substitution template db.js hands db.exec, db.prepare or db.pragma. AST, never regex.
function dbJsLiterals(): string[] {
    const sourceFile = parseDbJs();
    const texts: string[] = [];
    for (const call of findAll(sourceFile, ts.isCallExpression)) {
        const callee = call.expression;
        if (!ts.isPropertyAccessExpression(callee)) continue;
        if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'db') continue;
        if (!DB_METHODS.includes(callee.name.text)) continue;
        const arg = call.arguments[0];
        if (arg === undefined) continue;
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            texts.push(arg.text);
        }
    }
    return texts;
}

function dbJsDefaultSettings(): (readonly [string, string])[] {
    const declaration = findAll(parseDbJs(), ts.isVariableDeclaration)
        .find((node) => ts.isIdentifier(node.name) && node.name.text === 'defaultSettings');
    const initializer = declaration?.initializer;
    if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) {
        throw new Error('database/db.js no longer declares defaultSettings as an object literal.');
    }
    return initializer.properties.map((property): readonly [string, string] => {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) ||
            !ts.isStringLiteral(property.initializer)) {
            throw new Error('defaultSettings holds a property shape this reader does not know.');
        }
        return [property.name.text, property.initializer.text];
    });
}

const transcribed = (): string[] => [
    ...V121_INIT.map((entry) => entry.sql),
    ...Object.values(V121_STATEMENTS).flat()
];

function realSchema(): string {
    const text = fs.readFileSync(REAL_SCHEMA, 'utf8').replace(/\r\n/g, '\n');
    return text.slice(text.indexOf('CREATE TABLE'));
}

function replay(dbPath: string): void {
    const db = openDatabase(dbPath);
    try {
        executeV121Init(db);
    } finally {
        closeDatabase(db);
    }
}

function downgrade(dbPath: string): V121DowngradeResult {
    const db = openDatabase(dbPath);
    try {
        return runV121Downgrade(db, TODAY);
    } finally {
        closeDatabase(db);
    }
}

describe('D-26: the transcription is pinned to database/db.js', () => {
    it('holds exactly the statements db.js executes, as a multiset', () => {
        expect(fs.existsSync(DB_JS), PHASE_7_NOTE).toBe(true);
        // Sorted: db.js repeats two texts verbatim (the Unassigned SELECT, the week-total SELECT).
        expect([...transcribed()].sort()).toEqual([...dbJsLiterals()].sort());
    });

    it('holds the 13 raw default settings in db.js order', () => {
        expect(fs.existsSync(DB_JS), PHASE_7_NOTE).toBe(true);
        const settings = dbJsDefaultSettings();
        expect(settings).toHaveLength(13);
        expect(V121_DEFAULT_SETTINGS).toEqual(settings);
    });

    it('is not a vacuous comparison: db.js yields the statements this transcription claims', () => {
        expect(dbJsLiterals().length).toBe(44);
        expect(V121_INIT).toHaveLength(16);
    });
});

describe('D-13: one baseline path reaches the real v1.2.1 schema', () => {
    it.each(SHAPE_IDS)('shape %s replays to v121-real-schema.sql byte for byte', (shape) => {
        const fixture = copyFixture(buildLegacyFixture(shape, 'representative'));
        replay(fixture);
        expect(schemaOf(fixture)).toBe(realSchema());
    });

    it('a fresh database reaches the same schema, ALTER scars included', () => {
        const fresh = path.join(tempDir('fresh'), 'krono.db');
        replay(fresh);
        expect(schemaOf(fresh)).toBe(realSchema());
    });

    it('covers every pinned shape', () => {
        expect(Object.keys(SHAPES)).toEqual(SHAPE_IDS);
    });
});

describe('D-26: v1.2.1 still runs against a database it did not write', () => {
    it('replays, writes, reads and deletes on an untouched shape-C copy', () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'representative'));
        const result = downgrade(fixture);
        expect(result.failures).toEqual([]);
        expect(result.ok).toBe(true);
    });
});

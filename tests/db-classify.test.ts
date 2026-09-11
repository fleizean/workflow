// D-12 classification as a pure table, then through the read-only probe on real files. Expectations are restated
// here, never imported from the code under test; the fingerprints are pinned to the D-14 CREATE statements.

import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { classify, V1X_TABLE_PREFIXES, type DbClass, type ObservedDatabase } from '../src/lib/db/classify';
import { probeDatabase } from '../src/lib/db/probe';
import { buildLegacyFixture, cleanupLegacyFixtures, LEGACY_CORPUS, SHAPES, type LegacyShapeId } from './fixtures/legacy-shapes';
import { cleanupFixtures } from './fixtures/seed';

const LATEST = 2;
const SHAPE_IDS: readonly LegacyShapeId[] = ['A', 'B', 'C'];

const tempDirs: string[] = [];
function tempPath(name = 'krono.db'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-classify-'));
    tempDirs.push(dir);
    return path.join(dir, name);
}

afterAll(() => {
    cleanupLegacyFixtures();
    cleanupFixtures();
    while (tempDirs.length > 0) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const sha256 = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function write(dbPath: string, sql: string): string {
    const db = new Database(dbPath);
    try {
        db.exec(sql);
    } finally {
        db.close();
    }
    return dbPath;
}

function classifyFile(dbPath: string, latest = LATEST): DbClass {
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    return classify(probe.observed, latest);
}

// v1.2.1 as pragma_table_info reports it, ALTER columns last.
const V121_COLUMNS = {
    companies: ['id', 'name', 'created_at', 'updated_at', 'excel_column', 'note_column', 'note_required'],
    work_sessions: ['id', 'name', 'duration', 'date', 'created_at', 'company_id', 'note'],
    settings: ['key', 'value'],
    pomodoro_sessions: ['id', 'date', 'company_id', 'pomodoros_completed', 'created_at']
};
const V121_OBJECTS = [
    { type: 'table', name: 'companies' },
    { type: 'index', name: 'sqlite_autoindex_companies_1' },
    { type: 'table', name: 'sqlite_sequence' },
    { type: 'table', name: 'work_sessions' },
    { type: 'table', name: 'settings' },
    { type: 'index', name: 'sqlite_autoindex_settings_1' },
    { type: 'table', name: 'pomodoro_sessions' }
];

function observed(partial: Partial<ObservedDatabase>): ObservedDatabase {
    return { exists: true, userVersion: 0, objects: [], columns: {}, ...partial };
}

const v121 = (userVersion: number): ObservedDatabase =>
    observed({ userVersion, objects: V121_OBJECTS, columns: V121_COLUMNS });

describe('D-12: classify is a total function over observed facts', () => {
    const cases: [string, ObservedDatabase, number, DbClass][] = [
        ['no file', observed({ exists: false }), LATEST, 'fresh'],
        ['an existing file with no objects (0-byte)', observed({}), LATEST, 'fresh'],
        ['only sqlite_sequence and an autoindex', observed({
            objects: [{ type: 'table', name: 'sqlite_sequence' }, { type: 'index', name: 'sqlite_autoindex_x_1' }]
        }), LATEST, 'fresh'],
        ['the v1.2.1 tables', v121(0), LATEST, 'legacy'],
        ['shape A: no pomodoro_sessions, companies without export columns', observed({
            objects: [{ type: 'table', name: 'companies' }, { type: 'table', name: 'work_sessions' },
                { type: 'table', name: 'settings' }],
            columns: {
                companies: ['id', 'name', 'created_at', 'updated_at'],
                work_sessions: V121_COLUMNS.work_sessions,
                settings: ['key', 'value']
            }
        }), LATEST, 'legacy'],
        ['companies alone, fingerprint intact', observed({
            objects: [{ type: 'table', name: 'companies' }],
            columns: { companies: ['id', 'name', 'created_at', 'updated_at'] }
        }), LATEST, 'legacy'],
        ['v1.2.1 plus a third-party index and an extra trailing column', observed({
            objects: [...V121_OBJECTS, { type: 'index', name: 'third_party_date_idx' }],
            columns: { ...V121_COLUMNS, work_sessions: [...V121_COLUMNS.work_sessions, 'billed'] }
        }), LATEST, 'legacy'],
        ['settings alone (a v1.x name, but not an anchor table)', observed({
            objects: [{ type: 'table', name: 'settings' }], columns: { settings: ['key', 'value'] }
        }), LATEST, 'unrecognized'],
        ['only foreign objects', observed({ objects: [{ type: 'table', name: 'notes' }] }), LATEST, 'unrecognized'],
        ['a companies table whose columns are id, title', observed({
            objects: [{ type: 'table', name: 'companies' }], columns: { companies: ['id', 'title'] }
        }), LATEST, 'unrecognized'],
        ['v1.2.1 with the work_sessions columns reordered', observed({
            objects: V121_OBJECTS,
            columns: { ...V121_COLUMNS, work_sessions: ['id', 'name', 'date', 'duration', 'created_at'] }
        }), LATEST, 'unrecognized'],
        ['a v1.x table whose columns were not observed', observed({
            objects: V121_OBJECTS, columns: { companies: V121_COLUMNS.companies }
        }), LATEST, 'unrecognized'],
        ['a view named work_sessions', observed({ objects: [{ type: 'view', name: 'work_sessions' }] }), LATEST, 'unrecognized'],
        ['user_version 1 with LATEST 2', v121(1), LATEST, 'current-behind'],
        ['user_version 2 with LATEST 2', v121(2), LATEST, 'current'],
        ['user_version 3 with LATEST 2', v121(3), LATEST, 'newer'],
        ['user_version 10 with LATEST 9 (integers, not strings)', v121(10), 9, 'newer'],
        ['user_version 9 with LATEST 10', v121(9), 10, 'current-behind'],
        ['user_version -1', v121(-1), LATEST, 'unrecognized'],
        ['user_version 1.5', v121(1.5), LATEST, 'unrecognized'],
        ['user_version 2**53', v121(2 ** 53), LATEST, 'unrecognized'],
        ['user_version NaN', v121(Number.NaN), LATEST, 'unrecognized']
    ];

    it.each(cases)('%s', (_name, facts, latest, expected) => {
        expect(classify(facts, latest)).toBe(expected);
    });
});

describe('D-12: every class on a real file, through the read-only probe', () => {
    it('classifies a missing file fresh without creating it', () => {
        const dbPath = tempPath();
        expect(classifyFile(dbPath)).toBe('fresh');
        expect(fs.existsSync(dbPath)).toBe(false);
    });

    it('classifies a 0-byte file fresh', () => {
        const dbPath = tempPath();
        fs.writeFileSync(dbPath, '');
        expect(classifyFile(dbPath)).toBe('fresh');
        expect(fs.statSync(dbPath).size).toBe(0);
    });

    it('classifies a valid SQLite file with zero tables fresh', () => {
        const dbPath = write(tempPath(), 'CREATE TABLE gone (x); DROP TABLE gone;');
        expect(fs.statSync(dbPath).size).toBeGreaterThan(0);
        expect(classifyFile(dbPath)).toBe('fresh');
    });

    it.each(SHAPE_IDS)('adopts the shape %s representative fixture as legacy', (shape) => {
        expect(classifyFile(buildLegacyFixture(shape, 'representative'))).toBe('legacy');
    });

    it.each(SHAPE_IDS)('adopts the zero-row shape %s fixture as legacy, not fresh', (shape) => {
        expect(classifyFile(buildLegacyFixture(shape, 'empty'))).toBe('legacy');
    });

    it('refuses a file holding only a foreign table', () => {
        expect(classifyFile(write(tempPath(), 'CREATE TABLE notes (x);'))).toBe('unrecognized');
    });

    it('refuses a file whose companies table has the columns id, title', () => {
        expect(classifyFile(write(tempPath(), 'CREATE TABLE companies (id INTEGER PRIMARY KEY, title TEXT);')))
            .toBe('unrecognized');
    });

    it('adopts a v1.x fixture carrying a third-party index on work_sessions', () => {
        const dbPath = buildLegacyFixture('C', 'representative');
        write(dbPath, 'CREATE INDEX third_party_date_idx ON work_sessions (date);');
        expect(classifyFile(dbPath)).toBe('legacy');
    });

    it.each([
        [1, 'current-behind'],
        [2, 'current'],
        [3, 'newer']
    ] as const)('classifies user_version %i with LATEST 2 as %s', (version, expected) => {
        const dbPath = buildLegacyFixture('C', 'representative');
        write(dbPath, 'PRAGMA user_version = ' + String(version) + ';');
        expect(classifyFile(dbPath)).toBe(expected);
    });

    it('refuses a relative path without opening anything', () => {
        const probe = probeDatabase('krono.db');
        expect(probe.ok).toBe(false);
    });
});

describe('D-12: the probe never writes', () => {
    it('returns { ok: false } naming the path for a file of random bytes, and leaves its bytes unchanged', () => {
        const dbPath = tempPath();
        const bytes = crypto.randomBytes(8192);
        bytes.write('not sqlite', 0);
        fs.writeFileSync(dbPath, bytes);

        const probe = probeDatabase(dbPath);

        expect(probe.ok).toBe(false);
        if (probe.ok) return;
        expect(probe.reason).toContain(dbPath);
        expect(probe.reason).toMatch(/SQLITE_NOTADB/);
        expect(fs.readFileSync(dbPath).equals(bytes)).toBe(true);
    });

    it('leaves the main file SHA-256 identical for every LEGACY_CORPUS fixture, and adopts each one', async () => {
        const seen: string[] = [];
        for (const entry of LEGACY_CORPUS) {
            const dbPath = await entry.build();
            const before = sha256(dbPath);
            const probe = probeDatabase(dbPath);
            expect(probe.ok, entry.id).toBe(true);
            if (!probe.ok) continue;
            expect(sha256(dbPath), entry.id).toBe(before);
            expect(classify(probe.observed, LATEST), entry.id).toBe('legacy');
            seen.push(entry.id);
        }
        expect(seen).toHaveLength(LEGACY_CORPUS.length);
    });

    it('asserts foreign keys first on its own connection and issues no write', () => {
        const trace: string[] = [];
        const probe = probeDatabase(buildLegacyFixture('C', 'representative'), {
            verbose: (sql) => { trace.push(String(sql)); }
        });
        expect(probe.ok).toBe(true);
        expect(trace[0]).toBe('PRAGMA foreign_keys = ON');
        expect(trace.filter((sql) => /^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|BEGIN|REPLACE)\b/i.test(sql)))
            .toEqual([]);
    });
});

describe('D-14: the fingerprints come from the historical CREATE statements', () => {
    it('matches pragma_table_info of every SHAPES CREATE TABLE literal, and covers every fingerprinted table', () => {
        const pinned = new Set<string>();
        for (const shape of SHAPE_IDS) {
            for (const sql of SHAPES[shape].createStatements) {
                const db = new Database(':memory:');
                try {
                    db.exec(sql);
                    const tables = db
                        .prepare<[], { name: string }>(
                            "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'sqlite_sequence'"
                        )
                        .all()
                        .map((row) => row.name);
                    expect(tables, shape).toHaveLength(1);
                    const table = tables[0] as keyof typeof V1X_TABLE_PREFIXES;
                    const columns = db
                        .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid')
                        .all(table)
                        .map((row) => row.name);
                    expect(columns, shape + ' ' + table).toEqual(V1X_TABLE_PREFIXES[table]);
                    pinned.add(table);
                } finally {
                    db.close();
                }
            }
        }
        expect([...pinned].sort()).toEqual(Object.keys(V1X_TABLE_PREFIXES).sort());
    });
});

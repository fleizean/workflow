// D-06/D-13/D-17/D-18: a fresh file and every v1.x shape reach v2 through the real registry and the real baseline,
// the schema at v1 is the real v1.2.1 text, and the committed migration bytes hash to the values approved at the door.

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import type { MigrationOptions, MigrationReport, MigrationStep } from '../src/lib/db/runner';
import { LATEST, MIGRATIONS } from '../src/lib/db/migrations/registry';
import { findAll, repoRoot } from './helpers/ts-imports';
import { cleanupFixtures, copyFixture, schemaOf } from './fixtures/seed';
import { SHAPES, buildLegacyFixture, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
import type { LegacyShapeId } from './fixtures/legacy-shapes';
import { V121_DEFAULT_SETTINGS, V121_INIT } from './helpers/v121-sql';
import { PINNED_SQL_SHA256 } from './fixtures/migration-pins';

const SHAPE_IDS: readonly LegacyShapeId[] = ['A', 'B', 'C'];
const MIGRATIONS_DIR = path.join(repoRoot, 'src', 'lib', 'db', 'migrations');
const BASELINE_FILE = path.join(repoRoot, 'src', 'lib', 'db', 'baseline-v121.ts');
const REAL_SCHEMA = path.join(repoRoot, 'tests', 'fixtures', 'v121-real-schema.sql');
const DB_METHODS: readonly string[] = ['exec', 'prepare'];
const V1_ONLY = MIGRATIONS.slice(0, 1);

// Restated, never imported from the schema: exactly what v2 may add, in schemaOf's (type, name) order.
const V2_OBJECTS = [
    'CREATE INDEX `pomodoro_sessions_date_idx` ON `pomodoro_sessions` (`date`);',
    'CREATE INDEX `work_sessions_company_id_idx` ON `work_sessions` (`company_id`);',
    'CREATE INDEX `work_sessions_date_idx` ON `work_sessions` (`date`);',
    'CREATE TABLE `app_state` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text NOT NULL,\n\t' +
        '`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL\n);'
].join('\n\n');

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-baseline-' + tag + '-'));
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

function readOnly<T>(dbPath: string, read: (db: Database.Database) => T): T {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return read(db);
    } finally {
        db.close();
    }
}

const userVersionOf = (dbPath: string): unknown =>
    readOnly(dbPath, (db) => db.pragma('user_version', { simple: true }));

const settingsOf = (dbPath: string): [string, string][] =>
    readOnly(dbPath, (db) => db.prepare<[], { key: string; value: string }>('SELECT key, value FROM settings').all())
        .map((row): [string, string] => [row.key, row.value]);

const backupsIn = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.bak')).sort() : [];

function realSchema(): string {
    const text = fs.readFileSync(REAL_SCHEMA, 'utf8').replace(/\r\n/g, '\n');
    return text.slice(text.indexOf('CREATE TABLE'));
}

// Probes and classifies exactly as startup will; applyBaseline is never passed, so the production default applies.
async function migrateAt(
    dbPath: string,
    steps: readonly MigrationStep[],
    extra: Partial<MigrationOptions> = {}
): Promise<MigrationReport> {
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    const db = openDatabase(dbPath);
    try {
        return await migrateDatabase(db, {
            dbPath,
            dbClass: classify(probe.observed, steps.length),
            fromVersion: probe.observed.userVersion,
            backupDir: path.join(path.dirname(dbPath), 'backups'),
            steps,
            ...extra
        });
    } finally {
        closeDatabase(db);
    }
}

// Every string or no-substitution template the baseline hands db.exec or db.prepare. AST, never regex.
function baselineLiterals(): string[] {
    const source = fs.readFileSync(BASELINE_FILE, 'utf8');
    const sourceFile = ts.createSourceFile('baseline-v121.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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

describe('tracer: a missing krono.db reaches v2 through the real registry and the real baseline', () => {
    it('migrates on the production defaults alone, with no steps and no baseline passed in', async () => {
        const dir = tempDir('fresh');
        const dbPath = path.join(dir, 'krono.db');

        const probe = probeDatabase(dbPath);
        expect(probe).toEqual({ ok: true, observed: { exists: false, userVersion: 0, objects: [], columns: {} } });
        if (!probe.ok) return;
        const dbClass = classify(probe.observed, LATEST);
        expect(dbClass).toBe('fresh');

        const db = openDatabase(dbPath);
        let report: MigrationReport;
        try {
            // No `steps`, no `applyBaseline`: MIGRATIONS and applyV121Baseline are the defaults (D-06, D-13).
            report = await migrateDatabase(db, {
                dbPath,
                dbClass,
                fromVersion: probe.observed.userVersion,
                backupDir: path.join(dir, 'backups')
            });
        } finally {
            closeDatabase(db);
        }

        expect(report.applied).toEqual([1, 2]);
        expect(report.toVersion).toBe(2);
        expect(report.backupPath).toBeNull();
        expect(userVersionOf(dbPath)).toBe(2);
    });

    it('renders the real v1.2.1 schema at v1, ALTER scars included', async () => {
        const dbPath = path.join(tempDir('v1only'), 'krono.db');
        const report = await migrateAt(dbPath, V1_ONLY);

        expect(report.applied).toEqual([1]);
        expect(userVersionOf(dbPath)).toBe(1);
        expect(schemaOf(dbPath)).toBe(realSchema());
    });

    it('seeds exactly v1.2.1\'s own 13 raw default settings', async () => {
        const dbPath = path.join(tempDir('settings'), 'krono.db');
        await migrateAt(dbPath, V1_ONLY);

        expect(settingsOf(dbPath).sort()).toEqual([...V121_DEFAULT_SETTINGS].map(([k, v]) => [k, v]).sort());
    });

    it('adds exactly app_state and the three indexes on top of that schema', async () => {
        const dbPath = path.join(tempDir('full'), 'krono.db');
        await migrateAt(dbPath, MIGRATIONS);

        expect(userVersionOf(dbPath)).toBe(2);
        expect(schemaOf(dbPath)).toBe(V2_OBJECTS + '\n\n' + realSchema());
    });
});

describe('D-13/DATA-04: every v1.x shape adopts through the one baseline', () => {
    it('covers every pinned shape', () => {
        expect(Object.keys(SHAPES)).toEqual(SHAPE_IDS);
    });

    it.each(SHAPE_IDS)('shape %s reaches v2, and its v1-only copy renders the real schema', async (shape) => {
        const fixture = copyFixture(buildLegacyFixture(shape, 'representative'));
        const v1Copy = copyFixture(fixture);

        const v1Report = await migrateAt(v1Copy, V1_ONLY);
        expect(v1Report.dbClass).toBe('legacy');
        expect(userVersionOf(v1Copy)).toBe(1);
        expect(schemaOf(v1Copy)).toBe(realSchema());

        const report = await migrateAt(fixture, MIGRATIONS);
        expect(report.dbClass).toBe('legacy');
        expect(report.applied).toEqual([1, 2]);
        expect(userVersionOf(fixture)).toBe(2);
        expect(schemaOf(fixture)).toBe(V2_OBJECTS + '\n\n' + realSchema());
    });
});

describe('D-22 ordering: the backup exists before the baseline runs, and v1 commits before v2', () => {
    it('takes the backup before insideTransaction(1), and runs v1 before v2', async () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'representative'));
        const backupDir = path.join(path.dirname(fixture), 'backups');
        const seen: { version: number; backups: number }[] = [];

        const report = await migrateAt(fixture, MIGRATIONS, {
            now: new Date(2026, 5, 1, 9, 0, 0),
            hooks: { insideTransaction: (version) => { seen.push({ version, backups: backupsIn(backupDir).length }); } }
        });

        expect(seen.map((entry) => entry.version)).toEqual([1, 2]);
        expect(seen[0]?.backups).toBe(1);
        expect(report.backupPath).not.toBeNull();
        expect(userVersionOf(fixture)).toBe(2);
    });
});

describe('D-13: the baseline is pinned to v1.2.1\'s own statement list', () => {
    it('hands db.exec/db.prepare exactly V121_INIT\'s texts, in order', () => {
        expect(baselineLiterals()).toEqual(V121_INIT.map((entry) => entry.sql));
    });

    it('is not a vacuous comparison: the baseline issues all 16 statements', () => {
        expect(baselineLiterals()).toHaveLength(16);
        expect(V121_INIT).toHaveLength(16);
    });
});

describe('D-09/D-21: the committed migration bytes hash to the approved pins', () => {
    it('pins every .sql on disk, and nothing else', () => {
        const tags = fs.readdirSync(MIGRATIONS_DIR)
            .filter((name) => name.endsWith('.sql'))
            .map((name) => name.replace(/\.sql$/, ''))
            .sort();

        expect(tags).toEqual(Object.keys(PINNED_SQL_SHA256).sort());
        expect(tags).toEqual(MIGRATIONS.map((step) => step.tag).sort());

        for (const tag of tags) {
            const bytes = fs.readFileSync(path.join(MIGRATIONS_DIR, tag + '.sql'));
            expect(bytes.includes(13), tag + ' holds a CR; the pin is taken over LF bytes (D-09)').toBe(false);
            expect(createHash('sha256').update(bytes).digest('hex'), tag).toBe(PINNED_SQL_SHA256[tag]);
        }
    });

    it('registers the baseline as v1 with no SQL, and LATEST is the registry length', () => {
        expect(LATEST).toBe(MIGRATIONS.length);
        expect(LATEST).toBe(2);
        expect(MIGRATIONS.map((step) => step.version)).toEqual([1, 2]);
        expect(MIGRATIONS[0]?.kind).toBe('baseline');
        expect(MIGRATIONS[0]).not.toHaveProperty('sql');
    });
});

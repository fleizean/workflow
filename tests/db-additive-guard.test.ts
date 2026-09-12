// D-25/SC4 on the real registry and the whole corpus: the static guard over every kind 'sql' entry, a semantic
// delta per statement on every SHAPES fixture, the runtime trace of the real chain, and the six negative controls.

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { applyV121Baseline } from '../src/lib/db/baseline-v121';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase, splitStatements } from '../src/lib/db/runner';
import type { MigrationStep } from '../src/lib/db/runner';
import { LATEST, MIGRATIONS } from '../src/lib/db/migrations/registry';
import { cleanupFixtures, copyFixture } from './fixtures/seed';
import { LEGACY_CORPUS, buildLegacyFixture, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
import type { LegacyShapeId } from './fixtures/legacy-shapes';
import { executeV121Init } from './helpers/v121-sql';
import {
    V121_TABLES,
    checkAllowedDelta,
    checkMigrationSql,
    classifyStatement,
    checkRuntimeTrace,
    snapshotSchema
} from './helpers/additive-guard';
import type { GuardContext } from './helpers/additive-guard';

const SHAPE_IDS: readonly LegacyShapeId[] = ['A', 'B', 'C'];
const NOW = new Date(2026, 5, 1, 9, 0, 0);

// app_state is the one table this milestone creates; existing tables are v1.2.1's plus SQLite's own counter.
const ctx: GuardContext = {
    v121Tables: V121_TABLES,
    milestoneTables: ['app_state'],
    existingTables: [...V121_TABLES, 'sqlite_sequence']
};

const SQL_STEPS = MIGRATIONS.filter((step) => step.kind === 'sql');

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-guard-real-' + tag + '-'));
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

// A copy of a fixture brought to v1 by v1.2.1's own init, which is where a v2 statement is meant to land.
function atVersionOne(dbPath: string): string {
    const copy = copyFixture(dbPath);
    const db = openDatabase(copy);
    try {
        executeV121Init(db);
    } finally {
        closeDatabase(db);
    }
    return copy;
}

interface TracedRun {
    readonly trace: readonly string[];
    readonly threw: string | null;
}

// Runs the real chain (optionally with an injected extra step or baseline) under a verbose sink held in memory.
async function tracedMigrate(
    dbPath: string,
    steps: readonly MigrationStep[],
    applyBaseline?: (db: DatabaseType.Database) => void
): Promise<TracedRun> {
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    const trace: string[] = [];
    const db = openDatabase(dbPath, { verbose: (statement) => { trace.push(String(statement)); } });
    let threw: string | null = null;
    try {
        await migrateDatabase(db, {
            dbPath,
            dbClass: classify(probe.observed, steps.length),
            fromVersion: probe.observed.userVersion,
            backupDir: path.join(path.dirname(dbPath), 'backups'),
            now: NOW,
            steps,
            ...(applyBaseline === undefined ? {} : { applyBaseline })
        });
    } catch (error) {
        threw = error instanceof Error ? error.message : String(error);
    } finally {
        closeDatabase(db);
    }
    return { trace, threw };
}

const freshDatabase = (tag: string): string => path.join(tempDir(tag), 'krono.db');

describe('D-25.1: the static guard passes every registered kind \'sql\' file', () => {
    it('finds exactly one SQL step, and the baseline carries no SQL to check (Pitfall 3)', () => {
        expect(MIGRATIONS).toHaveLength(LATEST);
        expect(MIGRATIONS[0]?.kind, 'v1 is the imperative baseline').toBe('baseline');
        expect(MIGRATIONS[0], 'a baseline entry has no SQL, so the static guard cannot run over it')
            .not.toHaveProperty('sql');
        expect(SQL_STEPS.map((step) => step.tag)).toEqual(['0001_history_indexes_app_state']);
    });

    it.each(SQL_STEPS.map((step) => [step.tag, step] as const))('%s passes the D-20 allowlist', (tag, step) => {
        expect(step.kind).toBe('sql');
        if (step.kind !== 'sql') return;
        const result = checkMigrationSql(step.sql, ctx);
        expect(result.violations, tag).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.created, tag + ' creates exactly the approved objects').toEqual([
            'app_state',
            'pomodoro_sessions_date_idx',
            'work_sessions_date_idx',
            'work_sessions_company_id_idx'
        ]);
    });
});

describe('D-25: the semantic delta accepts each real statement on every SHAPES fixture at v1', () => {
    it.each(SHAPE_IDS)('shape %s takes every v2 statement as an additive delta', (shape) => {
        const atV1 = atVersionOne(buildLegacyFixture(shape, 'representative'));
        const db = openDatabase(atV1);
        try {
            for (const step of SQL_STEPS) {
                if (step.kind !== 'sql') continue;
                for (const chunk of splitStatements(step.sql)) {
                    const before = snapshotSchema(db);
                    db.prepare(chunk).run();
                    const after = snapshotSchema(db);
                    const violations = checkAllowedDelta(before, after, ctx).map((violation) => violation.rule);
                    expect(violations, shape + ': ' + chunk.slice(0, 40)).toEqual([]);
                }
            }
        } finally {
            closeDatabase(db);
        }
    });
});

describe('D-25.2: the runtime trace of the real chain passes over the whole corpus', () => {
    it('a fresh install executes nothing outside the allowlist', async () => {
        const run = await tracedMigrate(freshDatabase('fresh'), MIGRATIONS);
        expect(run.threw).toBeNull();
        expect(checkRuntimeTrace(run.trace, ctx)).toEqual([]);
    });

    it.each(LEGACY_CORPUS.map((entry) => [entry.id, entry] as const))(
        '%s executes nothing outside the allowlist',
        async (id, entry) => {
            const fixture = copyFixture(await entry.build());
            const run = await tracedMigrate(fixture, MIGRATIONS);
            expect(run.threw, id).toBeNull();
            expect(checkRuntimeTrace(run.trace, ctx), id).toEqual([]);
        },
        120_000
    );
});

// Each control is injected as a real extra step through the real runner, so it travels the same path a
// genuine migration would. The guard must catch it statically, and again in the executed trace.
const CONTROLS: readonly (readonly [string, string])[] = [
    ['a DROP', 'DROP TABLE work_sessions'],
    ['a RENAME', 'ALTER TABLE companies RENAME TO firms'],
    ['a NOT NULL tightening', 'ALTER TABLE work_sessions ADD COLUMN tightened INTEGER NOT NULL'],
    ['the rebuild shape', [
        'CREATE TABLE __new_work_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)',
        'INSERT INTO __new_work_sessions (id, name) SELECT id, name FROM work_sessions',
        'DROP TABLE work_sessions',
        'ALTER TABLE __new_work_sessions RENAME TO work_sessions'
    ].join('\n--> statement-breakpoint\n')],
    ['a TRIGGER', 'CREATE TRIGGER block_inserts BEFORE INSERT ON work_sessions ' +
        'BEGIN SELECT RAISE(ABORT, \'no\'); END'],
    ['a UNIQUE index on a v1.2.1 table', 'CREATE UNIQUE INDEX companies_name_idx ON companies (name)']
];

// Version 3, appended after the real registry: the control travels the runner's own path.
const controlStep = (sql: string): MigrationStep & { kind: 'sql' } =>
    ({ version: 3, tag: '0002_control', kind: 'sql', sql });

// WR-09: the one control the per-statement rules cannot refuse, so it exercises the whole-file layer alone.
// CREATE TABLE ... AS SELECT carries no forbidden keyword and reads as a plain create-table; only the rule over
// accepted statements sees that it copies rows.
const CTAS_CONTROL = 'CREATE TABLE work_sessions_archive AS SELECT * FROM work_sessions';

describe('D-25/WR-09: the whole-file layer refuses a copy the per-statement rules accept', () => {
    it('accepts the statement on its own, so the file-level verdict below is that layer\'s alone', () => {
        expect(classifyStatement(CTAS_CONTROL, ctx).allowed,
            'a per-statement rule now refuses it, so the whole-file layer is untested again').toBe(true);
    });

    it('refuses it at the file level, naming the rebuild shape', () => {
        const result = checkMigrationSql(CTAS_CONTROL, ctx);
        expect(result.ok).toBe(false);
        expect(result.violations.map((violation) => violation.rule).join('; ')).toContain('copies rows');
    });

    it('says nothing about the real registry, which copies no rows', () => {
        for (const step of SQL_STEPS) {
            expect(checkMigrationSql(step.sql, ctx).violations, step.tag).toEqual([]);
        }
    });
});

describe('D-25: the six negative controls, injected through the real entry points', () => {
    it.each(CONTROLS)('%s is refused by the static guard', (_label, sql) => {
        expect(checkMigrationSql(controlStep(sql).sql, ctx).violations.length).toBeGreaterThan(0);
    });

    it.each(CONTROLS)('%s executes, and the runtime trace refuses it', async (label, sql) => {
        const run = await tracedMigrate(freshDatabase('control'), [...MIGRATIONS, controlStep(sql)]);

        // SQLite accepts all six, so the trace is genuinely the layer under test here rather than the engine.
        expect(run.threw, label + ' never executed, so the runtime layer was not exercised').toBeNull();
        expect(checkRuntimeTrace(run.trace, ctx).length, label + ' ran and the trace did not catch it')
            .toBeGreaterThan(0);
    }, 60_000);

    it('a statement outside the D-13 list, injected through applyBaseline, fails the segment-1 check', async () => {
        const sneaky = (db: DatabaseType.Database): void => {
            applyV121Baseline(db);
            db.exec('ALTER TABLE companies ADD COLUMN sneaky TEXT');
        };
        const run = await tracedMigrate(freshDatabase('sneaky'), MIGRATIONS, sneaky);

        expect(run.threw).toBeNull();
        const violations = checkRuntimeTrace(run.trace, ctx);
        expect(violations.length, 'segment 1 is held to the enumerated D-13 statements').toBeGreaterThan(0);
        expect(violations.join(' | ')).toContain('segment 1');
    });

    it('the unmodified baseline passes the same segment-1 check, so the control is not vacuous', async () => {
        const run = await tracedMigrate(freshDatabase('honest'), MIGRATIONS, applyV121Baseline);
        expect(run.threw).toBeNull();
        expect(checkRuntimeTrace(run.trace, ctx)).toEqual([]);
    });
});

// D-20/D-25: the additive guard's own self-tests. The tokenizer and classifier are proven on sample statements
// first, then the six negative controls are rejected by at least two independent layers.

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { splitStatements } from '../src/lib/db/runner';
import { executeV121Init, V121_DEFAULT_SETTINGS, V121_INIT } from './helpers/v121-sql';
import {
    V121_TABLES,
    checkAllowedDelta,
    checkMigrationSql,
    checkRuntimeTrace,
    classifyStatement,
    snapshotSchema,
    tokenizeSql
} from './helpers/additive-guard';
import type { GuardContext } from './helpers/additive-guard';

// RESEARCH's captured 0001_history_indexes_app_state.sql, verbatim (LF, tab-indented).
const CAPTURED_0001 = [
    'CREATE TABLE `app_state` (',
    '\t`key` text PRIMARY KEY NOT NULL,',
    '\t`value` text NOT NULL,',
    '\t`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL',
    ');',
    '--> statement-breakpoint',
    'CREATE INDEX `pomodoro_sessions_date_idx` ON `pomodoro_sessions` (`date`);--> statement-breakpoint',
    'CREATE INDEX `work_sessions_date_idx` ON `work_sessions` (`date`);--> statement-breakpoint',
    'CREATE INDEX `work_sessions_company_id_idx` ON `work_sessions` (`company_id`);'
].join('\n');

const MILESTONE_TABLES = ['app_state'];

const ctx: GuardContext = {
    v121Tables: V121_TABLES,
    milestoneTables: MILESTONE_TABLES,
    existingTables: [...V121_TABLES, 'sqlite_sequence']
};

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-guard-' + tag + '-'));
    tempDirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// A v1.2.1-shaped database with no rows beyond what the baseline itself writes.
function v121Database(tag: string): string {
    const dbPath = path.join(tempDir(tag), 'krono.db');
    const db = openDatabase(dbPath);
    try {
        executeV121Init(db);
    } finally {
        closeDatabase(db);
    }
    return dbPath;
}

// Applies one statement and returns the before/after snapshots around it.
function applyOne(dbPath: string, sql: string): { violations: readonly string[]; threw: string | null } {
    const db = openDatabase(dbPath);
    try {
        const before = snapshotSchema(db);
        try {
            db.prepare(sql).run();
        } catch (error) {
            return { violations: [], threw: error instanceof Error ? error.message : String(error) };
        }
        const after = snapshotSchema(db);
        return { violations: checkAllowedDelta(before, after, ctx).map((v) => v.rule), threw: null };
    } finally {
        closeDatabase(db);
    }
}

// Applies a whole sequence and reports the delta across all of it, which is how a rebuild shows up.
function applyAll(dbPath: string, statements: readonly string[]): string[] {
    const db = openDatabase(dbPath);
    try {
        const before = snapshotSchema(db);
        for (const sql of statements) db.prepare(sql).run();
        const after = snapshotSchema(db);
        return checkAllowedDelta(before, after, ctx).map((violation) => violation.rule);
    } finally {
        closeDatabase(db);
    }
}

const staticViolations = (sql: string): string[] =>
    checkMigrationSql(sql, ctx).violations.map((violation) => violation.rule);

describe('the analysis itself: the tokenizer never reads comments, strings or quoted identifiers as keywords', () => {
    it('drops line and block comments and keeps string literals and quoted identifiers whole', () => {
        const tokens = tokenizeSql(
            '-- DROP TABLE work_sessions\n' +
            '/* RENAME TO firms */\n' +
            "INSERT INTO `app_state` (`key`, `value`) VALUES ('DROP TABLE work_sessions', \"VACUUM\");"
        );
        const words = tokens.filter((token) => token.kind === 'word').map((token) => token.value);
        expect(words, 'a forbidden word in a comment or a value must never be a keyword').not.toContain('DROP');
        expect(words).not.toContain('RENAME');
        expect(words).not.toContain('VACUUM');
        expect(words).toContain('INSERT');
        // SQLite reads a double-quoted word as an identifier, so "VACUUM" is an ident here, never a keyword.
        expect(tokens.filter((token) => token.kind === 'ident').map((token) => token.value))
            .toEqual(['app_state', 'key', 'value', 'VACUUM']);
        expect(tokens.filter((token) => token.kind === 'string')).toHaveLength(1);
    });

    it('upper-cases keywords while keeping the identifier text readable', () => {
        const tokens = tokenizeSql('create index work_sessions_date_idx on work_sessions (date)');
        expect(tokens[0]?.value).toBe('CREATE');
        expect(tokens[1]?.value).toBe('INDEX');
        expect(tokens[2]?.raw).toBe('work_sessions_date_idx');
    });

    it('inspects exactly the chunks the runner would execute (splitStatements)', () => {
        const result = checkMigrationSql(CAPTURED_0001, ctx);
        expect(result.statements).toHaveLength(splitStatements(CAPTURED_0001).length);
        expect(result.statements).toHaveLength(4);
    });
});

describe('D-20: the captured 0001 migration is allowed, statically and semantically', () => {
    it('passes the static guard and reports the objects it creates', () => {
        const result = checkMigrationSql(CAPTURED_0001, ctx);
        expect(result.violations).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.created).toEqual([
            'app_state',
            'pomodoro_sessions_date_idx',
            'work_sessions_date_idx',
            'work_sessions_company_id_idx'
        ]);
    });

    it('passes the semantic delta check statement by statement', () => {
        const dbPath = v121Database('additive');
        for (const chunk of splitStatements(CAPTURED_0001)) {
            expect(applyOne(dbPath, chunk), chunk.slice(0, 40)).toEqual({ violations: [], threw: null });
        }
    });
});

describe('D-25: the six negative controls', () => {
    it('control 1 - a DROP is rejected', () => {
        const sql = 'DROP TABLE work_sessions;';
        expect(staticViolations(sql).length).toBeGreaterThan(0);
        const applied = applyOne(v121Database('drop'), 'DROP TABLE work_sessions');
        expect(applied.violations.length, 'the semantic delta must see the table disappear').toBeGreaterThan(0);
    });

    it('control 2 - a RENAME of a table or a column is rejected', () => {
        expect(staticViolations('ALTER TABLE companies RENAME TO firms;').length).toBeGreaterThan(0);
        expect(staticViolations('ALTER TABLE companies RENAME COLUMN name TO title;').length).toBeGreaterThan(0);
        const renamedTable = applyOne(v121Database('rename-table'), 'ALTER TABLE companies RENAME TO firms');
        expect(renamedTable.violations.length).toBeGreaterThan(0);
        const renamedColumn = applyOne(v121Database('rename-column'), 'ALTER TABLE companies RENAME COLUMN name TO title');
        expect(renamedColumn.violations.length).toBeGreaterThan(0);
    });

    it('control 3 - a NOT NULL tightening without a default is rejected', () => {
        const sql = 'ALTER TABLE work_sessions ADD COLUMN x INTEGER NOT NULL';
        expect(staticViolations(sql).length).toBeGreaterThan(0);
        // Measured: SQLite 3.53.4 ACCEPTS this on an empty table, so the engine is not the backstop.
        // The semantic delta is the second independent layer for this control.
        const applied = applyOne(v121Database('notnull'), sql);
        expect(applied.threw, 'SQLite accepted the ALTER, as measured').toBeNull();
        expect(applied.violations, 'a new NOT NULL column with no default').toContain(
            'a new NOT NULL column with no default'
        );
    });

    it('control 4 - the rebuild sequence is rejected', () => {
        const steps = [
            'CREATE TABLE __new_work_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)',
            'INSERT INTO __new_work_sessions (id, name) SELECT id, name FROM work_sessions',
            'DROP TABLE work_sessions',
            'ALTER TABLE __new_work_sessions RENAME TO work_sessions'
        ];
        const violations = staticViolations(steps.join('\n--> statement-breakpoint\n'));
        expect(violations.length, 'the copy, the drop and the rename must each be caught').toBeGreaterThanOrEqual(3);
        // However it is spelled, the rebuilt table's own definition changes across the sequence.
        expect(applyAll(v121Database('rebuild'), steps).length).toBeGreaterThan(0);
    });

    it('control 5 - a TRIGGER is rejected, BEGIN ... END body included', () => {
        const trigger =
            'CREATE TRIGGER block_inserts BEFORE INSERT ON work_sessions ' +
            'BEGIN SELECT RAISE(ABORT, \'no\'); END';
        expect(staticViolations(trigger).length).toBeGreaterThan(0);
        const applied = applyOne(v121Database('trigger'), trigger);
        expect(applied.violations.length, 'a new trigger object must be a delta violation').toBeGreaterThan(0);
    });

    it('control 6 - a UNIQUE index on a v1.2.1 table is rejected', () => {
        const sql = 'CREATE UNIQUE INDEX companies_name_idx ON companies (name)';
        expect(staticViolations(sql).length).toBeGreaterThan(0);
        const applied = applyOne(v121Database('unique'), sql);
        expect(applied.violations.length, 'index_list.unique = 1 on a v1.2.1 table').toBeGreaterThan(0);
    });
});

describe('D-20: the rest of the forbidden list is rejected statically', () => {
    it.each([
        ['CREATE VIEW', 'CREATE VIEW recent AS SELECT * FROM work_sessions'],
        ['ALTER ... DROP COLUMN', 'ALTER TABLE companies DROP COLUMN note_column'],
        ['UPDATE of a v1.2.1 table', "UPDATE settings SET value = '1' WHERE key = 'daily_target'"],
        ['DELETE of a v1.2.1 table', 'DELETE FROM work_sessions WHERE id = 1'],
        ['INSERT into a v1.2.1 table', "INSERT INTO settings (key, value) VALUES ('a', 'b')"]
    ])('rejects %s', (_label, sql) => {
        expect(staticViolations(sql).length).toBeGreaterThan(0);
    });

    it.each([
        'PRAGMA user_version = 3',
        'BEGIN',
        'COMMIT',
        'ROLLBACK',
        'SAVEPOINT s1',
        'VACUUM',
        "ATTACH DATABASE 'other.db' AS other",
        'DETACH DATABASE other'
    ])('rejects %s as a statement (D-07)', (sql) => {
        expect(staticViolations(sql).length).toBeGreaterThan(0);
    });
});

describe('D-20: the allowed shapes are not over-rejected', () => {
    it('allows a UNIQUE index on a table this milestone created', () => {
        expect(staticViolations('CREATE UNIQUE INDEX app_state_key_idx ON app_state (key)')).toEqual([]);
    });

    it('allows ADD COLUMN when it is nullable or carries a constant DEFAULT', () => {
        expect(staticViolations('ALTER TABLE companies ADD COLUMN nickname TEXT')).toEqual([]);
        expect(staticViolations('ALTER TABLE companies ADD COLUMN flag INTEGER NOT NULL DEFAULT 0')).toEqual([]);
    });

    it('allows INSERT into a table this milestone created', () => {
        expect(staticViolations("INSERT INTO app_state (key, value) VALUES ('k', 'v')")).toEqual([]);
    });

    it('does not read a forbidden word hidden in a comment, a string or a quoted identifier', () => {
        expect(staticViolations('CREATE TABLE `drop` (id INTEGER) -- DROP TABLE work_sessions')).toEqual([]);
        expect(staticViolations("INSERT INTO app_state (key, value) VALUES ('k', 'DROP TABLE work_sessions')"))
            .toEqual([]);
        expect(staticViolations('/* VACUUM */ CREATE INDEX app_state_value_idx ON app_state (value)')).toEqual([]);
    });

    it('classifies a new CREATE TABLE by name and refuses one that already exists', () => {
        expect(classifyStatement('CREATE TABLE app_state (key TEXT)', ctx).allowed).toBe(true);
        expect(classifyStatement('CREATE TABLE companies (id INTEGER)', ctx).allowed).toBe(false);
    });
});

// The runner's own statements, by exact form (src/lib/db/runner.ts + src/lib/db/client.ts).
const CONNECTION_PRAGMAS = [
    'PRAGMA foreign_keys = ON',
    'PRAGMA foreign_keys',
    'PRAGMA busy_timeout = 5000',
    'PRAGMA journal_mode = WAL',
    'PRAGMA user_version'
];

const SEGMENT_ONE = [
    ...V121_INIT.map((entry) => entry.sql),
    // The trace expands bound values, so the runner's own statements arrive with literals inlined.
    'UPDATE work_sessions SET company_id = 1 WHERE company_id IS NULL',
    ...V121_DEFAULT_SETTINGS.map(
        ([key, value]) => "INSERT OR IGNORE INTO settings (key, value) VALUES ('" + key + "', '" + value + "')"
    )
];

function acceptedTrace(): string[] {
    return [
        ...CONNECTION_PRAGMAS,
        'PRAGMA foreign_key_check',
        'BEGIN IMMEDIATE',
        ...SEGMENT_ONE,
        'PRAGMA foreign_key_check',
        'PRAGMA user_version = 1',
        'COMMIT',
        'BEGIN IMMEDIATE',
        ...splitStatements(CAPTURED_0001),
        'PRAGMA foreign_key_check',
        'PRAGMA user_version = 2',
        'COMMIT'
    ];
}

describe('D-25.2: the runtime trace checker', () => {
    it('accepts a trace shaped like the runner over the real baseline and the captured 0001', () => {
        expect(checkRuntimeTrace(acceptedTrace(), ctx)).toEqual([]);
    });

    it('rejects an ALTER in segment 1 that is not one of the D-13 statements', () => {
        const trace = acceptedTrace();
        trace.splice(trace.indexOf('BEGIN IMMEDIATE') + 1, 0, 'ALTER TABLE companies ADD COLUMN sneaky TEXT');
        expect(checkRuntimeTrace(trace, ctx).length).toBeGreaterThan(0);
    });

    it('rejects an UPDATE of settings in segment 2', () => {
        const trace = acceptedTrace();
        trace.splice(trace.lastIndexOf('PRAGMA user_version = 2'), 0,
            "UPDATE settings SET value = '0' WHERE key = 'daily_target'");
        expect(checkRuntimeTrace(trace, ctx).length).toBeGreaterThan(0);
    });

    it('rejects a DDL statement outside any segment', () => {
        const trace = acceptedTrace();
        trace.unshift('CREATE INDEX rogue_idx ON work_sessions (date)');
        expect(checkRuntimeTrace(trace, ctx).length).toBeGreaterThan(0);
    });

    it('rejects a segment that never writes user_version', () => {
        const trace = acceptedTrace().filter((statement) => statement !== 'PRAGMA user_version = 2');
        expect(checkRuntimeTrace(trace, ctx).length).toBeGreaterThan(0);
    });

    it('names the rule and the statement head, never a bound value', () => {
        const trace = acceptedTrace();
        trace.splice(trace.lastIndexOf('PRAGMA user_version = 2'), 0,
            "UPDATE settings SET value = 'secret-value' WHERE key = 'daily_target'");
        const reported = checkRuntimeTrace(trace, ctx).join(' | ');
        expect(reported).not.toContain('secret-value');
        expect(reported).toContain('UPDATE');
    });
});

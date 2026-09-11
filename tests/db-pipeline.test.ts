// D-05 spike: drizzle-kit generate emits plain SQL the runner applies chunk by chunk, an additive change emits no
// rebuild, and PRAGMA user_version rolls back with its transaction. Regenerated into temp directories on every run.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { repoRoot } from './helpers/ts-imports';

const KIT = path.join(repoRoot, 'node_modules', 'drizzle-kit', 'bin.cjs');
const SCHEMA = path.join(repoRoot, 'src', 'lib', 'db', 'schema.ts');
const SPIKE_SCHEMA = path.join(repoRoot, 'tests', 'fixtures', 'drizzle-spike', 'schema-plus-extra.ts');
const OUT = 'out';
const BREAKPOINT = '--> statement-breakpoint';
const BASELINE_NAME = 'v121_baseline';
const BASELINE_FILE = '0000_v121_baseline.sql';
const V121_TABLES = ['companies', 'work_sessions', 'settings', 'pomodoro_sessions'];
const FORBIDDEN_IN_MIGRATION = /\b(PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|VACUUM|ATTACH|DETACH)\b/i;
const REBUILD_OR_DESTRUCTIVE = /__new_|\b(INSERT|DROP|RENAME|ALTER)\b/i;

interface Journal {
    dialect: string;
    entries: { tag: string; breakpoints: boolean }[];
}

const tempDirs: string[] = [];
function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-drizzle-'));
    tempDirs.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Two Windows quirks of drizzle-kit 0.31.10: --schema is a glob, so it takes forward slashes; an absolute --out is
// joined onto the cwd when earlier snapshots are read (still exit 0), so --out stays relative and output is checked.
function generate(workDir: string, schema: string, name: string): string {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const schemaGlob = schema.split(path.sep).join('/');
    const run = spawnSync(
        process.execPath,
        [KIT, 'generate', '--dialect', 'sqlite', '--schema', schemaGlob, '--out', OUT, '--name', name],
        { cwd: workDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
    );
    const output = run.stdout + run.stderr;
    if (run.error !== undefined || run.status !== 0 || /\bError\b/.test(output)) {
        throw new Error(
            'drizzle-kit generate --name ' + name + ' failed (status ' + String(run.status) + ')' +
            (run.error === undefined ? '' : ': ' + run.error.message) + '\n' + output
        );
    }
    return output;
}

const sqlFiles = (workDir: string): string[] =>
    fs.readdirSync(path.join(workDir, OUT)).filter((file) => file.endsWith('.sql')).sort();

const readSql = (workDir: string, file: string): string => fs.readFileSync(path.join(workDir, OUT, file), 'utf8');

const readJournal = (workDir: string): Journal =>
    JSON.parse(fs.readFileSync(path.join(workDir, OUT, 'meta', '_journal.json'), 'utf8')) as Journal;

// The runner's split: one statement per breakpoint-separated chunk.
const chunksOf = (sql: string): string[] => sql.split(BREAKPOINT).map((chunk) => chunk.trim()).filter((chunk) => chunk !== '');

const firstKeyword = (chunk: string): string => (/^[A-Za-z]+/.exec(chunk)?.[0] ?? '').toUpperCase();

const schemaObjects = (db: Database.Database): string[] =>
    db.prepare<[], { name: string }>('SELECT name FROM sqlite_master ORDER BY name').all().map((row) => row.name);

let baselineDir: string | undefined;
function baseline(): string {
    if (baselineDir === undefined) {
        const dir = tempDir();
        generate(dir, SCHEMA, BASELINE_NAME);
        baselineDir = dir;
    }
    return baselineDir;
}

describe('D-05 item 1: what drizzle-kit generate emits for this schema', () => {
    it('(a) emits one LF file of CREATE chunks with the expected v1.2.1 constructs', () => {
        const dir = baseline();
        expect(sqlFiles(dir), 'one generate run into a fresh directory writes one file').toEqual([BASELINE_FILE]);
        const sql = readSql(dir, BASELINE_FILE);

        expect(sql).toContain(BREAKPOINT);
        for (const table of V121_TABLES) {
            expect(sql, 'no CREATE TABLE for ' + table).toContain('CREATE TABLE `' + table + '`');
        }
        expect(sql).toContain('CREATE UNIQUE INDEX `companies_name_unique`');
        expect(sql).toContain('PRIMARY KEY AUTOINCREMENT NOT NULL');
        expect(sql).toContain('DEFAULT CURRENT_TIMESTAMP');
        expect(sql, 'the default gained parentheses').not.toContain('(CURRENT_TIMESTAMP)');
        expect(sql, 'pomodoro_sessions.created_at lost DATETIME (NUMERIC affinity)').toContain('`created_at` DATETIME');
        expect(sql).toContain('ON DELETE cascade');
        expect(sql.includes('\r'), 'generated SQL must be LF').toBe(false);

        expect(sql, 'a migration file may not control transactions or connection state (D-07)').not.toMatch(FORBIDDEN_IN_MIGRATION);
        const keywords = chunksOf(sql).map(firstKeyword);
        expect(keywords.length).toBeGreaterThanOrEqual(V121_TABLES.length + 1);
        expect(keywords.filter((keyword) => keyword !== 'CREATE'), 'every chunk must be a CREATE').toEqual([]);

        const journal = readJournal(dir);
        expect(journal.dialect).toBe('sqlite');
        expect(journal.entries).toHaveLength(1);
        expect(journal.entries[0]?.tag).toBe('0000_' + BASELINE_NAME);
        expect(journal.entries[0]?.breakpoints).toBe(true);
    }, 60_000);

    it('(b) executes chunk by chunk through prepare().run() inside an immediate transaction', () => {
        const chunks = chunksOf(readSql(baseline(), BASELINE_FILE));
        const db = openDatabase(path.join(tempDir(), 'pipeline.db'));
        try {
            db.transaction(() => {
                for (const chunk of chunks) {
                    db.prepare(chunk).run();
                }
            }).immediate();

            expect(schemaObjects(db)).toEqual(expect.arrayContaining([...V121_TABLES, 'companies_name_unique']));
            const createdAt = db.prepare<[], { type: string }>(
                'SELECT type FROM pragma_table_info(\'pomodoro_sessions\') WHERE name = \'created_at\''
            ).get();
            expect(createdAt?.type).toBe('DATETIME');

            // The fail-closed property the runner relies on: a chunk hiding two statements is refused.
            expect(() => db.prepare('CREATE TABLE a (x); CREATE TABLE b (y);')).toThrow(RangeError);
        } finally {
            closeDatabase(db);
        }
    }, 60_000);

    it('(c) emits only CREATE statements for an additive change: no rebuild, copy, drop, rename or alter', () => {
        const dir = tempDir();
        generate(dir, SCHEMA, BASELINE_NAME);
        const before = sqlFiles(dir);
        generate(dir, SPIKE_SCHEMA, 'spike_additive');
        const added = sqlFiles(dir).filter((file) => !before.includes(file));
        expect(added).toEqual(['0001_spike_additive.sql']);

        const sql = readSql(dir, '0001_spike_additive.sql');
        expect(sql).not.toMatch(REBUILD_OR_DESTRUCTIVE);
        expect(sql).not.toMatch(FORBIDDEN_IN_MIGRATION);
        const chunks = chunksOf(sql);
        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toMatch(/^CREATE TABLE `spike_probe`/);
        expect(chunks[1]).toMatch(/^CREATE INDEX `spike_probe_label_idx`/);
    }, 60_000);

    it('(e) reports no changes when the schema is regenerated unchanged, and writes nothing', () => {
        const dir = baseline();
        const before = sqlFiles(dir);
        expect(generate(dir, SCHEMA, BASELINE_NAME)).toContain('No schema changes');
        expect(sqlFiles(dir)).toEqual(before);
        expect(readJournal(dir).entries).toHaveLength(1);
    }, 60_000);
});

describe('D-05 item 2 / DATA-02: PRAGMA user_version rolls back with its transaction', () => {
    const FAILURE = 'migration failed after its DDL';
    const COMBINATIONS = [
        { form: 'pragma', mode: 'deferred' },
        { form: 'pragma', mode: 'immediate' },
        { form: 'exec', mode: 'deferred' },
        { form: 'exec', mode: 'immediate' }
    ] as const;

    const readState = (db: Database.Database): { version: unknown; objects: string[] } =>
        ({ version: db.pragma('user_version', { simple: true }), objects: schemaObjects(db) });

    it.each(COMBINATIONS)('(d) db.$form, $mode: a throw after DDL and user_version = 7 leaves version 0 and no table', ({ form, mode }) => {
        const dbPath = path.join(tempDir(), 'rollback.db');
        const migration = (fail: boolean) => (): void => {
            db.prepare('CREATE TABLE probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)').run();
            db.prepare('CREATE INDEX probe_label_idx ON probe (label)').run();
            if (form === 'pragma') {
                db.pragma('user_version = 7');
            } else {
                db.exec('PRAGMA user_version = 7');
            }
            if (fail) {
                throw new Error(FAILURE);
            }
        };

        let db = openDatabase(dbPath);
        try {
            expect(readState(db)).toEqual({ version: 0, objects: [] });
            const failing = db.transaction(migration(true));
            expect(() => (mode === 'immediate' ? failing.immediate() : failing.deferred())).toThrow(FAILURE);
            expect(db.inTransaction).toBe(false);
            expect(readState(db), 'same connection after the throw').toEqual({ version: 0, objects: [] });
        } finally {
            closeDatabase(db);
        }

        db = openDatabase(dbPath);
        try {
            expect(readState(db), 'after reopening').toEqual({ version: 0, objects: [] });
            const committing = db.transaction(migration(false));
            if (mode === 'immediate') {
                committing.immediate();
            } else {
                committing.deferred();
            }
        } finally {
            closeDatabase(db);
        }

        db = openDatabase(dbPath);
        try {
            expect(readState(db), 'the same body without the throw commits').toEqual({ version: 7, objects: ['probe', 'probe_label_idx'] });
        } finally {
            closeDatabase(db);
        }
    }, 60_000);
});

// D-08/D-09/D-22: the committed migration bytes hash to the values approved at the schema door, and the
// registry, the drizzle journal and the files on disk agree on which migrations exist and in what order.

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase, splitStatements } from '../src/lib/db/runner';
import type { MigrationOptions, MigrationReport, MigrationStep } from '../src/lib/db/runner';
import { LATEST, MIGRATIONS } from '../src/lib/db/migrations/registry';
import { eagerImports, findAll, repoRoot, stripCommentsAndStrings } from './helpers/ts-imports';
import { PINNED_SQL_SHA256 } from './fixtures/migration-pins';
import { cleanupFixtures, copyFixture } from './fixtures/seed';
import { buildLegacyFixture, cleanupLegacyFixtures } from './fixtures/legacy-shapes';

const MIGRATIONS_DIR = path.join(repoRoot, 'src', 'lib', 'db', 'migrations');
const JOURNAL = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');
const REGISTRY = path.join(MIGRATIONS_DIR, 'registry.ts');
const KIT = path.join(repoRoot, 'node_modules', 'drizzle-kit', 'bin.cjs');
const SCHEMA = path.join(repoRoot, 'src', 'lib', 'db', 'schema.ts');

// Only the imperative D-13 replay may sniff a table's columns to decide whether to ALTER (DATA-17).
// The other two hits are the read-only `pragma_table_info(?)` table-valued function, which decides no write:
// probe.ts selects from it for the D-12 classifier, and runner.ts for the WR-02 post-step column check, which
// only ever refuses. Every reader is pinned here so a new one fails closed.
const TABLE_INFO_LITERALS: Readonly<Record<string, number>> = Object.freeze({
    'src/lib/db/baseline-v121.ts': 2,
    'src/lib/db/probe.ts': 1,
    'src/lib/db/runner.ts': 1
});

const PRAGMA_TABLE_INFO = /PRAGMA\s+table_info/i;

// What v2 adds on top of v1, restated rather than read from 0001.sql: app_state, the autoindex SQLite
// builds for its TEXT PRIMARY KEY, and the three named history indexes.
const V2_NEW_OBJECTS = [
    'app_state',
    'pomodoro_sessions_date_idx',
    'sqlite_autoindex_app_state_1',
    'work_sessions_company_id_idx',
    'work_sessions_date_idx'
];

interface JournalEntry {
    idx: number;
    tag: string;
    breakpoints: boolean;
}

interface Journal {
    dialect: string;
    entries: JournalEntry[];
}

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-registry-' + tag + '-'));
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

const git = (args: string[]): string => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

const trackedUnder = (dir: string): string[] =>
    git(['ls-files', '-z', '--', dir]).split('\0').filter((file) => file !== '');

const schemaObjects = (dbPath: string): string[] => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return db.prepare<[], { name: string }>('SELECT name FROM sqlite_master ORDER BY name')
            .all().map((row) => row.name);
    } finally {
        db.close();
    }
};

const sqlTags = (): string[] =>
    fs.readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .map((name) => name.replace(/\.sql$/, ''))
        .sort();

const bytesOf = (tag: string): Buffer => fs.readFileSync(path.join(MIGRATIONS_DIR, tag + '.sql'));

const readJournal = (): Journal => JSON.parse(fs.readFileSync(JOURNAL, 'utf8')) as Journal;

const sqlSteps = (): Extract<MigrationStep, { kind: 'sql' }>[] =>
    MIGRATIONS.filter((step): step is Extract<MigrationStep, { kind: 'sql' }> => step.kind === 'sql');

const backupsIn = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.bak')) : [];

const userVersionOf = (dbPath: string): unknown => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return db.pragma('user_version', { simple: true });
    } finally {
        db.close();
    }
};

// Probes and classifies exactly as startup does; no steps and no baseline are passed, so the production
// registry and the real D-13 replay are what run.
async function migrateReal(dbPath: string, extra: Partial<MigrationOptions> = {}): Promise<MigrationReport> {
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    // A short step list is its own LATEST, so a v1-only run classifies against 1 rather than the registry's 2.
    const steps = extra.steps ?? MIGRATIONS;
    const db = openDatabase(dbPath);
    try {
        return await migrateDatabase(db, {
            dbPath,
            dbClass: classify(probe.observed, steps.length),
            fromVersion: probe.observed.userVersion,
            backupDir: path.join(path.dirname(dbPath), 'backups'),
            ...extra
        });
    } finally {
        closeDatabase(db);
    }
}

describe('D-09: the committed migration bytes are pinned to what was approved at the door', () => {
    it('hashes every committed .sql to its approved pin', () => {
        const tags = sqlTags();
        expect(tags.length, 'there must be migration files to pin').toBeGreaterThan(0);

        for (const tag of tags) {
            const bytes = bytesOf(tag);
            expect(bytes.includes(13), tag + ' holds a CR; the pin is taken over LF bytes').toBe(false);
            expect(createHash('sha256').update(bytes).digest('hex'), tag).toBe(PINNED_SQL_SHA256[tag]);
        }
    });

    it('pins every .sql on disk, and names no file that is not there', () => {
        expect(Object.keys(PINNED_SQL_SHA256).sort()).toEqual(sqlTags());
    });

    it('holds pairwise distinct pins, so a regenerated duplicate of an existing migration is rejected', () => {
        const pins = Object.values(PINNED_SQL_SHA256);
        expect(new Set(pins).size, 'two migrations hash alike').toBe(pins.length);
    });

    it('carries each sql step through the registry as that file\'s own bytes', () => {
        const steps = sqlSteps();
        expect(steps.length).toBeGreaterThan(0);

        for (const step of steps) {
            expect(step.sql, step.tag + ' registry SQL differs from the committed file')
                .toBe(bytesOf(step.tag).toString('utf8'));
        }
    });
});

describe('D-08: the registry is the order, and the journal agrees with it', () => {
    it('numbers the registry 1..n with no gap or duplicate, and LATEST is its length', () => {
        expect(MIGRATIONS.map((step) => step.version)).toEqual(MIGRATIONS.map((_step, index) => index + 1));
        expect(LATEST).toBe(MIGRATIONS.length);
        expect(LATEST).toBe(2);
    });

    it('matches the drizzle journal tag for tag, in order', () => {
        expect(readJournal().entries.map((entry) => entry.tag)).toEqual(MIGRATIONS.map((step) => step.tag));
    });

    it('registers every .sql exactly once, and no registry tag lacks a file', () => {
        const registered = MIGRATIONS.map((step) => step.tag).sort();
        expect(registered, 'a tag is registered twice').toEqual([...new Set(registered)].sort());
        expect(registered).toEqual(sqlTags());
    });

    it('records breakpoints true for every journal entry', () => {
        const journal = readJournal();
        expect(journal.entries.length).toBeGreaterThan(0);
        expect(journal.entries.filter((entry) => entry.breakpoints !== true)).toEqual([]);
    });

    it('registers the baseline with no SQL, and gives every sql step at least one statement', () => {
        const baseline = MIGRATIONS[0];
        expect(baseline?.kind).toBe('baseline');
        expect(baseline).not.toHaveProperty('sql');

        for (const step of sqlSteps()) {
            expect(splitStatements(step.sql).length, step.tag + ' registers an empty migration')
                .toBeGreaterThan(0);
        }
    });
});

describe('D-22: a database already at LATEST is left alone', () => {
    it('applies nothing and takes no backup on a second run', async () => {
        const dir = tempDir('current');
        const dbPath = path.join(dir, 'krono.db');
        const backupDir = path.join(dir, 'backups');

        const first = await migrateReal(dbPath, { backupDir });
        expect(first.applied).toEqual([1, 2]);
        expect(userVersionOf(dbPath)).toBe(LATEST);

        const again = await migrateReal(dbPath, { backupDir });

        expect(again.dbClass).toBe('current');
        expect(again.applied).toEqual([]);
        expect(again.backupPath).toBeNull();
        expect(again.pruned).toEqual([]);
        expect(backupsIn(backupDir), 'a current database must not be backed up').toEqual([]);
    });
});

describe('D-09: the migration bytes do not depend on the checkout', () => {
    it('checks every tracked migration file out with eol=lf', () => {
        const files = trackedUnder('src/lib/db/migrations');
        expect(files.length, 'the migrations directory must be tracked').toBeGreaterThan(0);

        // -z output is flat triplets: path, attribute, value.
        const fields = git(['check-attr', '-z', 'eol', '--', ...files]).split('\0');
        const eol = new Map<string, string>();
        for (let i = 0; i + 2 < fields.length; i += 3) eol.set(fields[i] ?? '', fields[i + 2] ?? '');

        const notLf = files.filter((f) => eol.get(f) !== 'lf').map((f) => f + ' (eol: ' + (eol.get(f) ?? 'missing') + ')');
        expect(notLf).toEqual([]);
    });
});

describe('D-08: migrations are ordered by the registry, never by the filesystem', () => {
    it('imports only its ?raw SQL and a type, with no glob, readdir or sort', () => {
        const source = fs.readFileSync(REGISTRY, 'utf8');
        const { code, sourceFile } = stripCommentsAndStrings('registry.ts', source);

        // Value imports only: the `import type` of MigrationStep is excluded by eagerImports.
        const specifiers = eagerImports(sourceFile).map((entry) => entry.specifier);
        expect(specifiers.length).toBeGreaterThan(0);
        expect(specifiers.filter((specifier) => !specifier.endsWith('.sql?raw'))).toEqual([]);

        // Comments and string literals are blanked, so prose naming these cannot register as code.
        expect(code).not.toContain('import.meta.glob');

        const called = findAll(sourceFile, ts.isCallExpression).map((call) => {
            const callee = call.expression;
            if (ts.isIdentifier(callee)) return callee.text;
            return ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        });
        expect(called.filter((name) => /^(readdir|readdirSync|sort)$/.test(name))).toEqual([]);
    });
});

describe('DATA-17: the imperative adoption path is quarantined', () => {
    it('reads a table\'s columns in exactly the pinned files, and sniffs PRAGMA table_info only in the baseline', () => {
        const files = trackedUnder('src').filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));
        expect(files.length, 'src must hold tracked TypeScript').toBeGreaterThan(0);

        const counts: Record<string, number> = {};
        const pragmaFiles = new Set<string>();

        for (const file of files) {
            const { strings } = stripCommentsAndStrings(file, fs.readFileSync(path.join(repoRoot, file), 'utf8'));
            const hits = strings.filter((token) => token.value.includes('table_info'));
            if (hits.length > 0) counts[file.split(path.sep).join('/')] = hits.length;
            if (hits.some((token) => PRAGMA_TABLE_INFO.test(token.value))) {
                pragmaFiles.add(file.split(path.sep).join('/'));
            }
        }

        expect(counts).toEqual(TABLE_INFO_LITERALS);
        expect([...pragmaFiles]).toEqual(['src/lib/db/baseline-v121.ts']);
    });
});

describe('D-08: nothing drizzle-managed tracks these migrations', () => {
    it('creates no __drizzle_migrations table on a fresh database', async () => {
        const dbPath = path.join(tempDir('fresh-tracking'), 'krono.db');
        await migrateReal(dbPath);

        expect(userVersionOf(dbPath)).toBe(LATEST);
        expect(schemaObjects(dbPath)).not.toContain('__drizzle_migrations');
    });

    it('creates no __drizzle_migrations table when a legacy database is adopted', async () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'representative'));
        const report = await migrateReal(fixture);

        expect(report.dbClass).toBe('legacy');
        expect(report.applied).toEqual([1, 2]);
        expect(schemaObjects(fixture)).not.toContain('__drizzle_migrations');
    });
});

describe('DATA-14/DATA-15: schema.ts and the committed migrations cannot drift apart', () => {
    it('reports no schema changes when drizzle-kit regenerates over the committed migrations', () => {
        // Generated into a mkdtemp copy: the repository's own migrations are never a generate target.
        // The .sql and meta/ artifacts are written out one by one - these are SQL and JSON text, and a
        // directory copy helper would read as copying a database (CUSTODY-03).
        const work = tempDir('drift');
        const out = path.join(work, 'out');
        fs.mkdirSync(path.join(out, 'meta'), { recursive: true });
        const prefix = 'src/lib/db/migrations/';
        for (const file of trackedUnder('src/lib/db/migrations')) {
            const rel = file.slice(prefix.length);
            if (!rel.endsWith('.sql') && !rel.startsWith('meta/')) continue;
            fs.writeFileSync(path.join(out, rel), fs.readFileSync(path.join(repoRoot, file)));
        }
        const before = fs.readdirSync(out).filter((file) => file.endsWith('.sql')).sort();

        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.NODE_OPTIONS;

        // drizzle-kit 0.31.10 on Windows: --schema is a glob (forward slashes), --out is relative to cwd.
        const run = spawnSync(
            process.execPath,
            [KIT, 'generate', '--dialect', 'sqlite', '--schema', SCHEMA.split(path.sep).join('/'),
                '--out', 'out', '--name', 'drift_check'],
            { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
        );
        const output = run.stdout + run.stderr;

        expect(run.error, 'drizzle-kit did not run').toBeUndefined();
        expect(run.status, output).toBe(0);
        expect(output, 'schema.ts has changes the committed migrations do not carry').toContain('No schema changes');
        expect(fs.readdirSync(out).filter((file) => file.endsWith('.sql')).sort()).toEqual(before);
    }, 60_000);
});

describe('D-17/D-18/D-19: v2 adds exactly app_state and the three history indexes', () => {
    it('adds those objects and nothing else on top of v1', async () => {
        const atV1 = path.join(tempDir('delta-v1'), 'krono.db');
        const atLatest = path.join(tempDir('delta-v2'), 'krono.db');

        const v1Report = await migrateReal(atV1, { steps: MIGRATIONS.slice(0, 1) });
        expect(v1Report.applied).toEqual([1]);
        expect(userVersionOf(atV1)).toBe(1);

        await migrateReal(atLatest);
        expect(userVersionOf(atLatest)).toBe(LATEST);

        const before = schemaObjects(atV1);
        const after = schemaObjects(atLatest);

        expect(after.filter((name) => !before.includes(name)).sort()).toEqual(V2_NEW_OBJECTS);
        expect(before.filter((name) => !after.includes(name)), 'v2 removed an object').toEqual([]);
    });
});

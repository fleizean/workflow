// The migration runner on real files: transaction shape, failure, backup and prune ordering, FK delta, anomaly report
// and zero pending (D-07, D-15, D-22). Steps and baseline are injected; every fixture lives in mkdtemp.

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';
import { backupDatabase, PENDING_SUFFIX, readDatabaseStats, verifyBackup } from '../src/lib/db/backup';
import { classify, type DbClass } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { MigrationFailedError, migrateDatabase, type MigrationOptions, type MigrationStep } from '../src/lib/db/runner';
import { buildLegacyFixture, cleanupLegacyFixtures, type LegacyShapeId } from './fixtures/legacy-shapes';
import { cleanupFixtures, makeOrphanFixture, readV121Ddl } from './fixtures/seed';

const tempDirs: string[] = [];
const openHandles: DatabaseType.Database[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-runner-'));
    tempDirs.push(dir);
    return dir;
}

function open(dbPath: string): DatabaseType.Database {
    const db = openDatabase(dbPath);
    openHandles.push(db);
    return db;
}

function openTraced(dbPath: string): { db: DatabaseType.Database; trace: string[] } {
    const trace: string[] = [];
    const db = openDatabase(dbPath, { verbose: (sql) => { trace.push(String(sql)); } });
    openHandles.push(db);
    return { db, trace };
}

afterEach(() => {
    while (openHandles.length > 0) closeDatabase(openHandles.pop() as DatabaseType.Database);
    while (tempDirs.length > 0) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

afterAll(() => {
    cleanupLegacyFixtures();
    cleanupFixtures();
});

function readOnly<T>(dbPath: string, read: (db: DatabaseType.Database) => T): T {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return read(db);
    } finally {
        db.close();
    }
}

function write(dbPath: string, sql: string): void {
    const db = new Database(dbPath);
    try {
        db.exec(sql);
    } finally {
        db.close();
    }
}

const userVersionOf = (dbPath: string): unknown => readOnly(dbPath, (db) => db.pragma('user_version', { simple: true }));

const objectNamesOf = (dbPath: string): string[] =>
    readOnly(dbPath, (db) => db.prepare<[], { name: string }>('SELECT name FROM sqlite_master ORDER BY name').all())
        .map((row) => row.name);

const sha256 = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Every work_sessions column through quote(), so a type change (90.5 -> '90.5') changes the digest.
const sessionsDigest = (dbPath: string): string => readOnly(dbPath, (db) => crypto.createHash('sha256').update(
    JSON.stringify(db.prepare(
        'SELECT quote(id), quote(name), quote(duration), quote(date), quote(created_at), quote(company_id), ' +
        'quote(note) FROM work_sessions ORDER BY id'
    ).raw().all())
).digest('hex'));

const backupsIn = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.bak')).sort() : [];

const WRITES = /^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|BEGIN)\b/i;

const baselineStandIn = (db: DatabaseType.Database): void => { db.exec(readV121Ddl()); };
const adoptionMarker = (db: DatabaseType.Database): void => { db.prepare('CREATE TABLE adopted_marker (x)').run(); };

const BASELINE: MigrationStep = { version: 1, tag: '0000_stand_in', kind: 'baseline' };
const PROBE_STEP: MigrationStep = {
    version: 2,
    tag: '0001_probe',
    kind: 'sql',
    sql: 'CREATE TABLE `t_probe` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`label` text NOT NULL\n);\n' +
        '--> statement-breakpoint\nCREATE INDEX `t_probe_label_idx` ON `t_probe` (`label`);'
};
const sqlStep = (version: number, sql: string): MigrationStep => ({ version, tag: 'step_' + String(version), kind: 'sql', sql });

// Restated fixture strings a failure message must never carry (T-01-37).
const PRIVATE_STRINGS = ['Unassigned', 'Northwind Fixture', 'Contoso Fixture', 'Fixture task', 'Morning block', 'Loose block'];

interface Prepared {
    dbPath: string;
    dir: string;
    dbClass: DbClass;
    fromVersion: number;
}

// Probes and classifies exactly as startup will, against the injected LATEST.
function prepare(dbPath: string, latest: number): Prepared {
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    return { dbPath, dir: path.dirname(dbPath), dbClass: classify(probe.observed, latest), fromVersion: probe.observed.userVersion };
}

function options(prepared: Prepared, steps: readonly MigrationStep[], extra: Partial<MigrationOptions> = {}): MigrationOptions {
    return {
        dbPath: prepared.dbPath,
        dbClass: prepared.dbClass,
        fromVersion: prepared.fromVersion,
        backupDir: path.join(prepared.dir, 'backups'),
        steps,
        applyBaseline: adoptionMarker,
        ...extra
    };
}

async function failureOf(run: Promise<unknown>): Promise<MigrationFailedError> {
    try {
        await run;
    } catch (error) {
        if (error instanceof MigrationFailedError) return error;
        throw error;
    }
    throw new Error('expected a MigrationFailedError, and the migration succeeded');
}

function legacyAt(shape: LegacyShapeId, variant: Parameters<typeof buildLegacyFixture>[1], userVersion = 0): string {
    const dbPath = buildLegacyFixture(shape, variant);
    if (userVersion !== 0) write(dbPath, 'PRAGMA user_version = ' + String(userVersion) + ';');
    return dbPath;
}

describe('tracer: a missing krono.db is probed, classified fresh, opened and migrated one committed step at a time', () => {
    it('reaches the injected LATEST with every step committed separately', async () => {
        const dir = tempDir();
        const dbPath = path.join(dir, 'krono.db');
        const steps = [BASELINE, PROBE_STEP];

        const probe = probeDatabase(dbPath);
        expect(probe).toEqual({ ok: true, observed: { exists: false, userVersion: 0, objects: [], columns: {} } });
        if (!probe.ok) return;
        const dbClass = classify(probe.observed, steps.length);
        expect(dbClass).toBe('fresh');

        const committed: number[] = [];
        const db = open(dbPath);
        const report = await migrateDatabase(db, {
            dbPath,
            dbClass,
            fromVersion: probe.observed.userVersion,
            backupDir: path.join(dir, 'backups'),
            steps,
            applyBaseline: baselineStandIn,
            hooks: { afterCommit: (version) => { committed.push(version); } }
        });
        closeDatabase(db);

        expect(committed).toEqual([1, 2]);
        expect(report.applied).toEqual([1, 2]);
        expect(report.toVersion).toBe(2);
        expect(report.backupPath).toBeNull();
        expect(userVersionOf(dbPath)).toBe(2);
        expect(objectNamesOf(dbPath)).toEqual(expect.arrayContaining(['t_probe', 't_probe_label_idx', 'work_sessions']));
        expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    });
});

describe('D-07: a failing step rolls back alone and stops the run', () => {
    it('rolls back a step that throws after its DDL and its bump, and attempts no later step', async () => {
        const dbPath = path.join(tempDir(), 'krono.db');
        const prepared = prepare(dbPath, 3);
        const committed: number[] = [];
        const db = open(dbPath);
        const namesBefore = fs.readdirSync(prepared.dir).filter((name) => name === 'krono.db');

        const error = await failureOf(migrateDatabase(db, options(prepared, [
            BASELINE, sqlStep(2, 'CREATE TABLE t_two (x)'), sqlStep(3, 'CREATE TABLE t_three (x)')
        ], {
            applyBaseline: baselineStandIn,
            hooks: {
                insideTransaction: (version) => { if (version === 2) throw new Error('kill point inside version 2'); },
                afterCommit: (version) => { committed.push(version); }
            }
        })));
        expect(db.inTransaction).toBe(false);
        closeDatabase(db);

        expect(error.version).toBe(2);
        expect(error.backupPath).toBeNull();
        expect(error.cause).toBeInstanceOf(Error);
        expect(committed).toEqual([1]);
        expect(userVersionOf(dbPath)).toBe(1);
        expect(objectNamesOf(dbPath)).not.toContain('t_two');
        expect(objectNamesOf(dbPath)).not.toContain('t_three');
        expect(fs.readdirSync(prepared.dir).filter((name) => name === 'krono.db')).toEqual(namesBefore);
    });

    it('leaves user_version 2 when the third of three pending steps fails', async () => {
        const dbPath = path.join(tempDir(), 'krono.db');
        const prepared = prepare(dbPath, 3);
        const db = open(dbPath);

        const error = await failureOf(migrateDatabase(db, options(prepared, [
            BASELINE,
            sqlStep(2, 'CREATE TABLE t_two (x)'),
            sqlStep(3, 'CREATE TABLE t_three (x);\n--> statement-breakpoint\nINSERT INTO t_missing VALUES (1);')
        ], { applyBaseline: baselineStandIn })));
        closeDatabase(db);

        expect(error.version).toBe(3);
        expect(userVersionOf(dbPath)).toBe(2);
        expect(objectNamesOf(dbPath)).toContain('t_two');
        expect(objectNamesOf(dbPath)).not.toContain('t_three');
    });

    it('refuses a pending baseline with no baseline supplied, before any statement', async () => {
        const dbPath = path.join(tempDir(), 'krono.db');
        const prepared = prepare(dbPath, 2);
        const { db, trace } = openTraced(dbPath);

        const error = await failureOf(migrateDatabase(db, options(prepared, [BASELINE, PROBE_STEP], { applyBaseline: undefined })));
        closeDatabase(db);

        expect(error.version).toBe(1);
        expect(trace.filter((sql) => WRITES.test(sql))).toEqual([]);
        expect(userVersionOf(dbPath)).toBe(0);
    });

    it.each([
        ['a gap', [BASELINE, sqlStep(3, 'CREATE TABLE t (x)')]],
        ['a duplicate', [BASELINE, sqlStep(2, 'CREATE TABLE t (x)'), sqlStep(2, 'CREATE TABLE u (x)')]],
        ['a step with no statements', [BASELINE, sqlStep(2, '--> statement-breakpoint\n  ')]]
    ] as const)('refuses a step list with %s before anything runs', async (_name, steps) => {
        const dbPath = path.join(tempDir(), 'krono.db');
        const prepared = prepare(dbPath, steps.length);
        const { db, trace } = openTraced(dbPath);

        await expect(migrateDatabase(db, options(prepared, steps))).rejects.toThrow(/without gaps or duplicates|no statements/);
        closeDatabase(db);

        expect(trace.filter((sql) => WRITES.test(sql))).toEqual([]);
        expect(userVersionOf(dbPath)).toBe(0);
        expect(objectNamesOf(dbPath)).toEqual([]);
    });
});

describe('D-22: backup before the first statement, prune after the last commit', () => {
    it.each([
        ['legacy', 0, 1],
        ['current-behind', 1, 2]
    ] as const)('backs up a %s file before its first pending step, verified against the source', async (expectedClass, version, firstPending) => {
        const dbPath = legacyAt('C', 'representative', version);
        const prepared = prepare(dbPath, 2);
        expect(prepared.dbClass).toBe(expectedClass);
        const expected = readDatabaseStats(dbPath);
        const backupDir = path.join(prepared.dir, 'backups');
        const seenInside: { version: number; backups: string[] }[] = [];
        const db = open(dbPath);

        const report = await migrateDatabase(db, options(prepared, [BASELINE, PROBE_STEP], {
            now: new Date(2026, 5, 1, 9, 0, 0),
            hooks: { insideTransaction: (v) => { seenInside.push({ version: v, backups: backupsIn(backupDir) }); } }
        }));
        closeDatabase(db);

        const first = seenInside[0];
        expect(first?.version).toBe(firstPending);
        expect(first?.backups).toHaveLength(1);
        expect(report.backupPath).toBe(path.join(backupDir, first?.backups[0] ?? ''));
        expect(verifyBackup(report.backupPath ?? '')).toEqual(expected);
        expect(report.applied).toEqual(version === 0 ? [1, 2] : [2]);
        expect(userVersionOf(dbPath)).toBe(2);
    });

    it.each([
        ['missing', (dbPath: string): void => { void dbPath; }],
        ['0-byte', (dbPath: string): void => { fs.writeFileSync(dbPath, ''); }],
        ['zero-table', (dbPath: string): void => { write(dbPath, 'CREATE TABLE gone (x); DROP TABLE gone;'); }]
    ] as const)('takes no backup of a %s fresh file', async (_name, make) => {
        const dbPath = path.join(tempDir(), 'krono.db');
        make(dbPath);
        const prepared = prepare(dbPath, 2);
        expect(prepared.dbClass).toBe('fresh');
        const db = open(dbPath);

        const report = await migrateDatabase(db, options(prepared, [BASELINE, PROBE_STEP], { applyBaseline: baselineStandIn }));
        closeDatabase(db);

        expect(report.backupPath).toBeNull();
        expect(report.pruned).toEqual([]);
        expect(fs.existsSync(path.join(prepared.dir, 'backups'))).toBe(false);
        expect(userVersionOf(dbPath)).toBe(2);
    });

    it('sends nothing but reads to a current file, takes no backup and leaves user_version alone', async () => {
        const dbPath = legacyAt('C', 'representative', 2);
        const prepared = prepare(dbPath, 2);
        expect(prepared.dbClass).toBe('current');
        const { db, trace } = openTraced(dbPath);

        const report = await migrateDatabase(db, options(prepared, [BASELINE, PROBE_STEP]));
        closeDatabase(db);

        expect(report.applied).toEqual([]);
        expect(report.backupPath).toBeNull();
        expect(trace.filter((sql) => WRITES.test(sql))).toEqual([]);
        expect(userVersionOf(dbPath)).toBe(2);
        expect(fs.existsSync(path.join(prepared.dir, 'backups'))).toBe(false);
    });

    it('runs no statement when the backup cannot be written, and leaves the file byte-identical', async () => {
        const dbPath = legacyAt('C', 'representative');
        const prepared = prepare(dbPath, 2);
        const blocker = path.join(prepared.dir, 'blocker');
        fs.writeFileSync(blocker, 'a regular file where the backup directory should go');
        const before = sha256(dbPath);
        const { db, trace } = openTraced(dbPath);

        const error = await failureOf(migrateDatabase(db, options(prepared, [BASELINE, PROBE_STEP], {
            backupDir: path.join(blocker, 'backups')
        })));
        closeDatabase(db);

        expect(error.version).toBe(1);
        expect(error.backupPath).toBeNull();
        expect(trace.filter((sql) => WRITES.test(sql))).toEqual([]);
        expect(userVersionOf(dbPath)).toBe(0);
        expect(sha256(dbPath)).toBe(before);
    });

    async function withOlderBackups(dbPath: string, backupDir: string): Promise<string[]> {
        for (let day = 1; day <= 4; day++) {
            await backupDatabase(dbPath, backupDir, { now: new Date(2026, 0, day, 9, 0, 0) });
        }
        return backupsIn(backupDir);
    }

    it('prunes to three backups, the new one included, only after every step committed', async () => {
        const dbPath = legacyAt('C', 'representative');
        const prepared = prepare(dbPath, 2);
        const backupDir = path.join(prepared.dir, 'backups');
        const older = await withOlderBackups(dbPath, backupDir);
        expect(older).toHaveLength(4);
        let countInsideLast = -1;
        const db = open(dbPath);

        const report = await migrateDatabase(db, options(prepared, [BASELINE, PROBE_STEP], {
            now: new Date(2026, 5, 1, 9, 0, 0),
            hooks: { insideTransaction: (v) => { if (v === 2) countInsideLast = backupsIn(backupDir).length; } }
        }));
        closeDatabase(db);

        expect(countInsideLast).toBe(5);
        const left = backupsIn(backupDir);
        expect(left).toHaveLength(3);
        expect(left).toContain(path.basename(report.backupPath ?? ''));
        expect(left).toEqual(expect.arrayContaining([older[2], older[3]]));
        expect(report.pruned.map((file) => path.basename(file)).sort()).toEqual([older[0], older[1]]);
    });

    // CR-02: a failing migration leaves the file at its old version, so the next launch backs it up again. Pruning
    // only on the success path turned a migration that fails every time into one full-size copy per launch.
    it('prunes on the failure path too, keeping the backup it just took', async () => {
        const dbPath = legacyAt('C', 'representative');
        const prepared = prepare(dbPath, 2);
        const backupDir = path.join(prepared.dir, 'backups');
        const older = await withOlderBackups(dbPath, backupDir);
        expect(older).toHaveLength(4);
        const db = open(dbPath);

        const error = await failureOf(migrateDatabase(db, options(prepared, [BASELINE, sqlStep(2, 'INSERT INTO t_missing VALUES (1)')], {
            now: new Date(2026, 5, 1, 9, 0, 0)
        })));
        closeDatabase(db);

        expect(error.version).toBe(2);
        expect(error.backupPath).not.toBeNull();
        const left = backupsIn(backupDir);
        expect(left, 'a failed migration left retention unenforced').toHaveLength(3);
        expect(left, 'the backup the failed run took was pruned away')
            .toContain(path.basename(error.backupPath ?? ''));
        expect(left, 'the two oldest backups survived the prune').toEqual(expect.arrayContaining([older[2], older[3]]));
    });

    it('stays at the retained count across repeated failures, leaving no staging file behind', async () => {
        const dbPath = legacyAt('C', 'representative');
        const backupDir = path.join(path.dirname(dbPath), 'backups');
        const broken = [BASELINE, sqlStep(2, 'INSERT INTO t_missing VALUES (1)')];

        for (let attempt = 1; attempt <= 4; attempt++) {
            // Re-probed each time: the baseline commits, so the relaunch sees the file one version further on.
            const prepared = prepare(dbPath, 2);
            const db = open(dbPath);
            const error = await failureOf(migrateDatabase(db, options(prepared, broken, {
                now: new Date(2026, 5, attempt, 9, 0, 0)
            })));
            closeDatabase(db);
            expect(error.backupPath, 'attempt ' + String(attempt) + ' took no backup, so this proves nothing')
                .not.toBeNull();
            expect(backupsIn(backupDir).length, 'attempt ' + String(attempt) + ' pushed retention past three')
                .toBeLessThanOrEqual(3);
        }

        expect(fs.readdirSync(backupDir).filter((name) => name.endsWith(PENDING_SUFFIX)),
            'a staging file survived a completed backup').toEqual([]);
    });
});

describe('D-15: pre-existing violations do not block; a step that adds one fails', () => {
    it('migrates the orphan fixture and reports its orphan', async () => {
        const dbPath = makeOrphanFixture();
        const prepared = prepare(dbPath, 2);
        expect(prepared.dbClass).toBe('legacy');
        const db = open(dbPath);

        const report = await migrateDatabase(db, options(prepared, [BASELINE, PROBE_STEP]));
        closeDatabase(db);

        expect(report.applied).toEqual([1, 2]);
        expect(report.anomalies.foreignKeyViolations).toBe(1);
        expect(report.anomalies.orphanedSessions).toBe(1);
        expect(userVersionOf(dbPath)).toBe(2);
    });

    it('rolls back a step whose deferred foreign key it leaves violated', async () => {
        const dbPath = path.join(tempDir(), 'krono.db');
        const prepared = prepare(dbPath, 2);
        const db = open(dbPath);

        const error = await failureOf(migrateDatabase(db, options(prepared, [
            BASELINE,
            sqlStep(2,
                'CREATE TABLE t_child (id INTEGER PRIMARY KEY, company_id INTEGER REFERENCES companies(id) ' +
                'DEFERRABLE INITIALLY DEFERRED);\n--> statement-breakpoint\nINSERT INTO t_child (company_id) VALUES (999999);')
        ], { applyBaseline: baselineStandIn })));
        closeDatabase(db);

        expect(error.version).toBe(2);
        expect(error.message).toMatch(/foreign_key_check violations from 0 to 1/);
        expect(userVersionOf(dbPath)).toBe(1);
        expect(objectNamesOf(dbPath)).not.toContain('t_child');
    });
});

describe('D-15: anomalies are counted and left byte-identical', () => {
    it.each(['A', 'B', 'C'] as const)('reports the shape %s anomalies variant and changes no work_sessions byte', async (shape) => {
        const dbPath = legacyAt(shape, 'anomalies');
        const prepared = prepare(dbPath, 2);
        expect(prepared.dbClass).toBe('legacy');
        const before = sessionsDigest(dbPath);
        const db = open(dbPath);

        const report = await migrateDatabase(db, options(prepared, [BASELINE, PROBE_STEP]));
        closeDatabase(db);

        expect(report.anomalies).toEqual({
            foreignKeyViolations: 1,
            orphanedSessions: 1,
            malformedDates: 3,
            invalidDurations: 2
        });
        expect(sessionsDigest(dbPath)).toBe(before);
        expect(report).toMatchObject({ dbClass: 'legacy', fromVersion: 0, toVersion: 2, applied: [1, 2] });
    });
});

describe('T-01-37: failure messages name versions, paths and counts, never a row value', () => {
    it('carries no fixture company name or session note in any failure message', async () => {
        const messages: string[] = [];
        const failing: [string, MigrationStep[], Partial<MigrationOptions>][] = [
            ['unique', [BASELINE, sqlStep(2, "UPDATE companies SET name = 'Northwind Fixture' WHERE name = 'Unassigned'")], {}],
            ['not null', [BASELINE, sqlStep(2, 'UPDATE work_sessions SET name = NULL')], {}],
            ['fk delta', [BASELINE, sqlStep(2,
                'CREATE TABLE t_child (id INTEGER PRIMARY KEY, company_id INTEGER REFERENCES companies(id) ' +
                'DEFERRABLE INITIALLY DEFERRED);\n--> statement-breakpoint\nINSERT INTO t_child (company_id) VALUES (424242);')], {}],
            ['kill point', [BASELINE, PROBE_STEP], { hooks: { insideTransaction: () => { throw new Error('kill point'); } } }],
            ['backup', [BASELINE, PROBE_STEP], { backupDir: 'blocked' }]
        ];
        for (const [name, steps, extra] of failing) {
            const dbPath = legacyAt('C', 'representative');
            const prepared = prepare(dbPath, 2);
            if (extra.backupDir !== undefined) {
                const blocker = path.join(prepared.dir, 'blocker');
                fs.writeFileSync(blocker, 'x');
                extra.backupDir = path.join(blocker, 'backups');
            }
            const db = open(dbPath);
            const error = await failureOf(migrateDatabase(db, options(prepared, steps, extra)));
            closeDatabase(db);
            messages.push(name + ': ' + error.message);
        }

        expect(messages).toHaveLength(failing.length);
        for (const message of messages) {
            for (const secret of PRIVATE_STRINGS) {
                expect(message, message).not.toContain(secret);
            }
        }
    });
});

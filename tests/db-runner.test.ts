// The migration runner on real files: transaction shape, failure, backup and prune ordering, FK delta, anomaly report
// and zero pending (D-07, D-15, D-22). Steps and baseline are injected; every fixture lives in mkdtemp.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase, type MigrationStep } from '../src/lib/db/runner';
import { readV121Ddl } from './fixtures/seed';

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

afterEach(() => {
    while (openHandles.length > 0) closeDatabase(openHandles.pop() as DatabaseType.Database);
    while (tempDirs.length > 0) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function readOnly<T>(dbPath: string, read: (db: DatabaseType.Database) => T): T {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return read(db);
    } finally {
        db.close();
    }
}

const userVersionOf = (dbPath: string): unknown => readOnly(dbPath, (db) => db.pragma('user_version', { simple: true }));

const objectNamesOf = (dbPath: string): string[] =>
    readOnly(dbPath, (db) => db.prepare<[], { name: string }>('SELECT name FROM sqlite_master ORDER BY name').all())
        .map((row) => row.name);

const baselineStandIn = (db: DatabaseType.Database): void => { db.exec(readV121Ddl()); };

const BASELINE: MigrationStep = { version: 1, tag: '0000_stand_in', kind: 'baseline' };
const PROBE_STEP: MigrationStep = {
    version: 2,
    tag: '0001_probe',
    kind: 'sql',
    sql: 'CREATE TABLE `t_probe` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`label` text NOT NULL\n);\n' +
        '--> statement-breakpoint\nCREATE INDEX `t_probe_label_idx` ON `t_probe` (`label`);'
};

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

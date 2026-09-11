// D-27/DATA-16: the database the runner produces is the one schema.ts declares, proven under one normalization.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import * as schema from '../src/lib/db/schema';
import type { AppStateRow } from '../src/lib/db/schema';
import { compareColumnOrder, compareContracts, declaredContract, liveContract } from './helpers/schema-contract';
import type { NormalizedTable } from './helpers/schema-contract';

const EXPECTED_TABLES = ['app_state', 'companies', 'pomodoro_sessions', 'settings', 'work_sessions'];

// Every table schema.ts exports, so a table added there is covered without editing this list.
const DECLARED: readonly NormalizedTable[] = Object.values(schema)
    .filter((value) => is(value, SQLiteTable))
    .map((table) => declaredContract(table));

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-contract-' + tag + '-'));
    tempDirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Probes and classifies exactly as startup will: the production registry and the real D-13 replay run.
export async function migrateFresh(tag: string): Promise<string> {
    const dbPath = path.join(tempDir(tag), 'krono.db');
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    const db = openDatabase(dbPath);
    try {
        await migrateDatabase(db, {
            dbPath,
            dbClass: classify(probe.observed, LATEST),
            fromVersion: probe.observed.userVersion,
            backupDir: path.join(path.dirname(dbPath), 'backups')
        });
    } finally {
        closeDatabase(db);
    }
    return dbPath;
}

export function contractsOf(dbPath: string, tables: readonly string[]): Map<string, NormalizedTable> {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return new Map(tables.map((name) => [name, liveContract(db, name)]));
    } finally {
        db.close();
    }
}

describe('D-27/DATA-16: a fresh install equals the schema.ts declaration', () => {
    let fresh: string;
    let live: Map<string, NormalizedTable>;

    beforeAll(async () => {
        fresh = await migrateFresh('fresh');
        live = contractsOf(fresh, EXPECTED_TABLES);
    }, 60_000);

    it('declares exactly the five tables this contract covers', () => {
        expect(DECLARED.map((table) => table.name).sort()).toEqual(EXPECTED_TABLES);
    });

    it.each(EXPECTED_TABLES)('%s matches the declaration under the D-27 normalization', (name) => {
        const declared = DECLARED.find((table) => table.name === name);
        expect(declared, name + ' is not declared in schema.ts').toBeDefined();
        const observed = live.get(name);
        expect(observed, name + ' is not in the migrated database').toBeDefined();
        if (declared === undefined || observed === undefined) return;

        expect(compareContracts(observed, declared)).toEqual([]);
    });

    it.each(EXPECTED_TABLES)('%s declares its columns in the live order', (name) => {
        const declared = DECLARED.find((table) => table.name === name);
        const observed = live.get(name);
        if (declared === undefined || observed === undefined) throw new Error('missing contract for ' + name);

        expect(compareColumnOrder(observed, declared)).toEqual([]);
    });

    it('app_state passes the contract with zero rows, and still yields a row type', () => {
        const db = new Database(fresh, { readonly: true, fileMustExist: true });
        try {
            const counted = db.prepare<[], { c: number }>('SELECT count(*) AS c FROM app_state').get();
            expect(counted?.c, 'a fresh install creates app_state empty').toBe(0);
        } finally {
            db.close();
        }

        const row: AppStateRow = { key: 'k', value: 'v', updated_at: '2026-01-01 00:00:00' };
        expect(row.key).toBe('k');
    });
});

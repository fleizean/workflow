// D-08/D-09/D-22: the committed migration bytes hash to the values approved at the schema door, and the
// registry, the drizzle journal and the files on disk agree on which migrations exist and in what order.

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase, splitStatements } from '../src/lib/db/runner';
import type { MigrationOptions, MigrationReport, MigrationStep } from '../src/lib/db/runner';
import { LATEST, MIGRATIONS } from '../src/lib/db/migrations/registry';
import { repoRoot } from './helpers/ts-imports';
import { PINNED_SQL_SHA256 } from './fixtures/migration-pins';

const MIGRATIONS_DIR = path.join(repoRoot, 'src', 'lib', 'db', 'migrations');
const JOURNAL = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');

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
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

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
    const db = openDatabase(dbPath);
    try {
        return await migrateDatabase(db, {
            dbPath,
            dbClass: classify(probe.observed, LATEST),
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

// Phase 5 SC4: the Google Sheets export left the app on 2026-09-11; the data it wrote did not. Both halves are
// proven here - the vocabulary is gone from src/shared and src/main, and the columns and settings rows it filled
// survive a real migration untouched.

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import * as schema from '../src/lib/db/schema';
import { executeV121Init } from './helpers/v121-sql';
import { declaredContract, liveContract } from './helpers/schema-contract';
import { read, repoRoot, stripCommentsAndStrings } from './helpers/ts-imports';

// The names the v2 app surface gave the export. None may appear at all, comments included: nothing in src/shared or
// src/main has any reason to say them now.
const SURFACE_NAMES = ['scriptUrl', 'SheetsTarget', 'updateSheetsTarget', 'exportHalfHourPrecision'];

// The v1.2.1 column and setting names. A comment may explain what the database keeps; code and SQL may not name it,
// which is what "no service reads it" means while the repositories under src/lib/db still may.
const LEGACY_NAMES = ['excel_column', 'note_column', 'script_url', 'export_half_hour_precision'];

// Frozen until Phase 7 (D-01/D-04) and expected to keep every reference.
const LEGACY_FILES = ['main.js', 'database/db.js', 'src/pages/settings.html', 'src/pages/companies.html'];

const COMPANY = { name: 'Northwind Fixture', excelColumn: 'D', noteColumn: 'E' };
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxRetained/exec';

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-sheets-' + tag + '-'));
    tempDirs.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Git-known, committed or not: a file added by the very commit this guard is meant to catch is still scanned.
function appFiles(): string[] {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src/shared', 'src/main'], {
        cwd: repoRoot,
        encoding: 'utf8'
    })
        .split('\n')
        .map((line) => line.trim())
        .filter((file) => /\.tsx?$/.test(file) && fs.existsSync(path.join(repoRoot, file)));
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length;

function occurrences(file: string, source: string, haystack: string, names: readonly string[]): string[] {
    const found: string[] = [];
    for (const name of names) {
        for (let at = haystack.indexOf(name); at >= 0; at = haystack.indexOf(name, at + name.length)) {
            found.push(file + ':' + String(lineOf(source, at)) + ' ' + name);
        }
    }
    return found;
}

// Comments blanked, string literals kept: prose may describe the retained data, a query may not fetch it.
function inCodeAndStrings(file: string, names: readonly string[]): string[] {
    const source = read(file);
    const { code, strings } = stripCommentsAndStrings(file, source);
    return [
        ...occurrences(file, source, code, names),
        ...strings.flatMap((token) => names
            .filter((name) => token.value.includes(name))
            .map((name) => file + ':' + String(lineOf(source, token.start)) + ' ' + name))
    ].sort();
}

const inWholeText = (file: string, names: readonly string[]): string[] => {
    const source = read(file);
    return occurrences(file, source, source, names).sort();
};

// A v1.2.1 database whose export fields are filled in, as a real user's would be.
function v121FixtureWithExportData(): string {
    const dbPath = path.join(tempDir('fixture'), 'krono.db');
    const db = new Database(dbPath);
    try {
        db.pragma('journal_mode = WAL');
        executeV121Init(db);
        db.prepare<[string, string, string]>(
            'INSERT INTO companies (name, excel_column, note_column, note_required) VALUES (?, ?, ?, 1)'
        ).run(COMPANY.name, COMPANY.excelColumn, COMPANY.noteColumn);
        const setting = db.prepare<[string, string]>('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        setting.run('script_url', SCRIPT_URL);
        setting.run('export_half_hour_precision', 'true');
        db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
        db.close();
    }
    return dbPath;
}

// The production chain, exactly as startup runs it.
async function migrateAt(dbPath: string): Promise<void> {
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
}

describe('SC4: the Sheets vocabulary is gone from the app surface', () => {
    const files = appFiles();

    it('scans the files it guards', () => {
        expect(files, 'the scan cannot see the surface it guards').toEqual(expect.arrayContaining([
            'src/shared/schemas/index.ts', 'src/shared/ipc/contract.ts', 'src/shared/types/index.ts',
            'src/shared/constants/settings.ts', 'src/main/index.ts'
        ]));
    });

    it('finds a planted name (negative control)', () => {
        const planted = 'const a = 1; // scriptUrl\nconst sheets = { excel_column: 1 };\n';
        expect(occurrences('probe.ts', planted, planted, SURFACE_NAMES)).toEqual(['probe.ts:1 scriptUrl']);
        const stripped = stripCommentsAndStrings('probe.ts', planted);
        expect(occurrences('probe.ts', planted, stripped.code, LEGACY_NAMES)).toEqual(['probe.ts:2 excel_column']);
        expect(occurrences('probe.ts', planted, stripped.code, SURFACE_NAMES),
            'a comment must not read as code, or the LEGACY_NAMES scan below is stricter than it claims').toEqual([]);
    });

    it('names no scriptUrl, SheetsTarget, updateSheetsTarget or exportHalfHourPrecision', () => {
        expect(files.flatMap((file) => inWholeText(file, SURFACE_NAMES)),
            'SC4: the export surface is back on the IPC contract or in a main-process module').toEqual([]);
    });

    it('reads no excel_column, note_column, script_url or export_half_hour_precision', () => {
        expect(files.flatMap((file) => inCodeAndStrings(file, LEGACY_NAMES)),
            'SC4: a service reads retired data; the columns stay in the database and nothing above src/lib/db touches them')
            .toEqual([]);
    });

    it.each(LEGACY_FILES)('leaves the frozen v1.2.1 file %s with its own references', (file) => {
        expect(inWholeText(file, [...SURFACE_NAMES, ...LEGACY_NAMES]).length,
            'the v1.2.1 pages are frozen until Phase 7: this guard must stop at src/shared and src/main').toBeGreaterThan(0);
    });
});

describe('SC4: the database keeps the data the export wrote', () => {
    it('still declares companies.excel_column and companies.note_column in schema.ts', () => {
        const declared = declaredContract(schema.companies);
        for (const column of ['excel_column', 'note_column']) {
            expect(declared.columns.has(column),
                'SC4: schema.ts dropped ' + column + '; removing it from the app must not remove it from the database')
                .toBe(true);
        }
    });

    it('carries the columns and the settings rows through a real migration unchanged', async () => {
        const dbPath = v121FixtureWithExportData();
        await migrateAt(dbPath);

        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            expect(db.pragma('user_version', { simple: true }),
                'the chain did not migrate, so the retention below is proven against an unmigrated database').toBe(LATEST);
            const live = liveContract(db, 'companies');
            expect([...live.columns.keys()]).toEqual(expect.arrayContaining(['excel_column', 'note_column']));

            const company = db
                .prepare<[string], { excel_column: string | null; note_column: string | null }>(
                    'SELECT excel_column, note_column FROM companies WHERE name = ?'
                )
                .get(COMPANY.name);
            expect(company, 'the fixture company did not survive the migration').toBeDefined();
            expect(company?.excel_column).toBe(COMPANY.excelColumn);
            expect(company?.note_column).toBe(COMPANY.noteColumn);

            const settings = new Map(
                db.prepare<[], { key: string; value: string }>('SELECT key, value FROM settings').all()
                    .map((row) => [row.key, row.value] as const)
            );
            expect(settings.get('script_url'), 'SC4: the migration rewrote a setting the app no longer reads').toBe(SCRIPT_URL);
            expect(settings.get('export_half_hour_precision')).toBe('true');
        } finally {
            db.close();
        }
    });
});

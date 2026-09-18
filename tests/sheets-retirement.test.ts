// Phase 5 SC4 and V2-SCHEMA-01: the Google Sheets export left the app on 2026-09-11, and on 2026-09-13 its data
// followed. Both halves are proven here - the vocabulary is gone from src/shared, src/main and src/lib, and a real
// migration takes the two columns and the two settings rows out while everything beside them stays where it was.

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
import { readV121 } from './helpers/v121-source';

// The names the v2 app surface gave the export. None may appear at all, comments included: nothing in src/shared,
// src/main or src/lib has any reason to say them now.
const SURFACE_NAMES = ['scriptUrl', 'SheetsTarget', 'updateSheetsTarget', 'exportHalfHourPrecision'];

// The v1.2.1 column and setting names. A comment may explain what the database keeps; code and SQL may not name it,
// which is what "nothing reads it" means now that the repositories exist (owner decision, 2026-09-12).
const LEGACY_NAMES = ['excel_column', 'note_column', 'script_url', 'export_half_hour_precision'];

// The two places under src/lib that may still name them, each by name rather than by a wildcard. Both exist because
// version 1 is still v1.2.1's own schema, replayed verbatim and SHA-256 pinned: the columns are created there and
// removed again by 0002, so the text that creates them cannot be edited. schema.ts left this list with 0002, which
// is what "the app no longer has these columns" means now. Everything else under src/lib - the repositories
// included - is scanned like src/shared and src/main.
const LIB_EXEMPT_FILES = ['src/lib/db/baseline-v121.ts'];
const LIB_EXEMPT_DIR = 'src/lib/db/migrations/';
// The byte-pinned replay the directory exemption exists for; a .sql is not reached by the TypeScript scan on its own.
const MIGRATION_BASELINE = 'src/lib/db/migrations/0000_v121_baseline.sql';
const MIGRATION_RETIREMENT = 'src/lib/db/migrations/0002_sheets_retirement.sql';

// What companies holds once 0002 has run, in cid order.
const SURVIVING_COMPANY_COLUMNS = ['id', 'name', 'created_at', 'updated_at', 'note_required'];
const RETIRED_SETTINGS = ['script_url', 'export_half_hour_precision'];

/*
 * The control: the scan must be able to FIND the export surface, or it could be passing because it
 * looks nowhere. SPA-14 deleted all four in 08-F, so readV121() reads them out of the commit that
 * last carried them - the same claim about the same bytes, read from history instead of the worktree.
 */
const LEGACY_FILES = ['main.js', 'database/db.js', 'legacy/pages/settings.html', 'legacy/pages/companies.html'];

const COMPANY = { name: 'Northwind Fixture', excelColumn: 'D', noteColumn: 'E' };
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxRetained/exec';
const SESSION_SECONDS = 7_200;

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
function trackedTs(...dirs: string[]): string[] {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...dirs], {
        cwd: repoRoot,
        encoding: 'utf8'
    })
        .split('\n')
        .map((line) => line.trim())
        .filter((file) => /\.tsx?$/.test(file) && fs.existsSync(path.join(repoRoot, file)));
}

const isExempt = (file: string): boolean => LIB_EXEMPT_FILES.includes(file) || file.startsWith(LIB_EXEMPT_DIR);

function appFiles(): string[] {
    return trackedTs('src/shared', 'src/main', 'src/lib').filter((file) => !isExempt(file));
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

/*
 * The whole text of a file in the WORKTREE, comments included - nothing under src/shared, src/main or src/lib has
 * any reason to say these names, in code or in prose.
 *
 * Phase 11: this used to call readV121(), which reads the last COMMITTED bytes. Over a deleted v1.2.1 file that is
 * the only place to read from and is correct; over a live application file it meant the guard scanned the previous
 * commit's text, so an uncommitted edit that put the export surface back was invisible to it - and a brand new file
 * under src/ crashed the guard with "git knows no commit carrying", which is how it was found. trackedTs() lists
 * uncommitted files on purpose; this is what makes listing them useful.
 */
const inWholeText = (file: string, names: readonly string[]): string[] => {
    const source = read(file);
    return occurrences(file, source, source, names).sort();
};

/** The same scan over a file SPA-14 deleted, whose bytes exist only in the commit that last carried them (WR-08). */
const inFrozenV121 = (file: string, names: readonly string[]): string[] => {
    const source = readV121(file);
    return occurrences(file, source, source, names).sort();
};

// A v1.2.1 database whose export fields are filled in, as a real user's would be, with tracked time beside them.
function v121FixtureWithExportData(): string {
    const dbPath = path.join(tempDir('fixture'), 'krono.db');
    const db = new Database(dbPath);
    try {
        db.pragma('journal_mode = WAL');
        executeV121Init(db);
        db.prepare<[string, string, string]>(
            'INSERT INTO companies (name, excel_column, note_column, note_required) VALUES (?, ?, ?, 1)'
        ).run(COMPANY.name, COMPANY.excelColumn, COMPANY.noteColumn);
        db.prepare<[string, number, string]>(
            'INSERT INTO work_sessions (name, duration, date, company_id, note) ' +
            'VALUES (?, ?, ?, (SELECT id FROM companies WHERE name = ' + "'" + COMPANY.name + "'" + '), ' +
            "'Fixture note')"
        ).run('Billable block', SESSION_SECONDS, '2026-01-05');
        const setting = db.prepare<[string, string]>('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        setting.run('script_url', SCRIPT_URL);
        setting.run('export_half_hour_precision', 'true');
        db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
        db.close();
    }
    return dbPath;
}

interface DatabaseState {
    readonly userVersion: unknown;
    readonly companyColumns: readonly string[];
    readonly companies: readonly Record<string, unknown>[];
    readonly settings: ReadonlyMap<string, string>;
    readonly totalDuration: number;
}

// Read with the driver, not through a repository: the only honest way to ask what is on disk.
function readState(dbPath: string): DatabaseState {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return {
            userVersion: db.pragma('user_version', { simple: true }),
            companyColumns: [...liveContract(db, 'companies').columns.keys()],
            companies: db.prepare<[], Record<string, unknown>>('SELECT * FROM companies ORDER BY id').all(),
            settings: new Map(
                db.prepare<[], { key: string; value: string }>('SELECT key, value FROM settings').all()
                    .map((row) => [row.key, row.value] as const)
            ),
            totalDuration: db.prepare<[], { s: number }>(
                'SELECT COALESCE(sum(duration), 0) AS s FROM work_sessions'
            ).get()?.s ?? -1
        };
    } finally {
        db.close();
    }
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
            'src/shared/constants/settings.ts', 'src/main/index.ts',
            'src/lib/db/repositories/companies.repository.ts', 'src/lib/db/repositories/settings.repository.ts',
            'src/lib/db/repositories/sessions.repository.ts', 'src/lib/db/repositories/pomodoro.repository.ts'
        ]));
        expect(files.filter(isExempt), 'an exempt file must not also be scanned').toEqual([]);
    });

    // Each exemption is named, and each is shown to still carry what it is exempt for: an exemption over a file that
    // no longer says anything is dead weight that would quietly widen as the file changed.
    it.each(LIB_EXEMPT_FILES)('exempts %s, which still declares the columns the data lives in', (file) => {
        expect(inCodeAndStrings(file, LEGACY_NAMES).length,
            file + ' no longer names a retired column, so its exemption is stale').toBeGreaterThan(0);
    });

    it('exempts the migrations directory for a replay that still carries the v1.2.1 DDL', () => {
        expect(read(MIGRATION_BASELINE), 'the byte-pinned baseline stopped creating the columns it is exempt for')
            .toContain('excel_column');
    });

    it('exempts two places under src/lib and no more', () => {
        expect([...LIB_EXEMPT_FILES, LIB_EXEMPT_DIR]).toHaveLength(2);
        expect(trackedTs('src/lib').filter(isExempt).sort(),
            'a new TypeScript file under src/lib/db/migrations would inherit the directory exemption; name it here')
            .toEqual([...LIB_EXEMPT_FILES, 'src/lib/db/migrations/registry.ts'].sort());
    });

    it('exempts the migrations directory for the file that removes them as well', () => {
        expect(read(MIGRATION_RETIREMENT), 'the migration that retires the columns stopped naming one')
            .toContain('excel_column');
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
            'SC4: something reads retired data. The columns stay in the database, no repository selects, maps or ' +
            'exposes them, and only schema.ts and the pinned v1.2.1 replays may name them')
            .toEqual([]);
    });

    it.each(LEGACY_FILES)('leaves the frozen v1.2.1 file %s with its own references', (file) => {
        expect(inFrozenV121(file, [...SURFACE_NAMES, ...LEGACY_NAMES]).length,
            'the v1.2.1 pages are frozen until Phase 7: this guard must stop at src/shared and src/main').toBeGreaterThan(0);
    });
});

describe('V2-SCHEMA-01: the database no longer carries what the export wrote', () => {
    it('declares neither column in schema.ts', () => {
        expect([...declaredContract(schema.companies).columns.keys()].sort())
            .toEqual([...SURVIVING_COMPANY_COLUMNS].sort());
    });

    it('takes both columns and both settings rows out, and moves nothing else', async () => {
        const dbPath = v121FixtureWithExportData();

        const before = readState(dbPath);
        expect(before.companyColumns, 'the fixture must hold the columns this test is about')
            .toEqual(expect.arrayContaining(['excel_column', 'note_column']));
        expect(before.settings.get('script_url')).toBe(SCRIPT_URL);
        expect(before.settings.get('export_half_hour_precision')).toBe('true');
        expect(before.totalDuration, 'the fixture must hold tracked time for the claim below to mean anything')
            .toBe(SESSION_SECONDS);

        await migrateAt(dbPath);
        const after = readState(dbPath);

        expect(after.userVersion, 'the chain did not migrate, so nothing below is proven').toBe(LATEST);
        expect(after.companyColumns).toEqual(SURVIVING_COMPANY_COLUMNS);
        expect(after.settings.has('script_url')).toBe(false);
        expect(after.settings.has('export_half_hour_precision')).toBe(false);

        // And the other half of the claim: the retirement took nothing it was not sent for.
        expect(after.totalDuration, 'V2-SCHEMA-01: tracked time changed across the retirement')
            .toBe(before.totalDuration);
        expect([...after.settings.keys()].sort()).toEqual(
            [...before.settings.keys()].filter((key) => !RETIRED_SETTINGS.includes(key)).sort()
        );
        for (const [key, value] of after.settings) {
            expect(before.settings.get(key), 'settings key ' + key + ' changed across the retirement').toBe(value);
        }
        expect(after.companies, 'a company row changed beyond losing the two retired cells').toEqual(
            before.companies.map((row) => Object.fromEntries(
                Object.entries(row).filter(([column]) => SURVIVING_COMPANY_COLUMNS.includes(column))
            ))
        );
        expect(after.companies.some((row) => row.name === COMPANY.name),
            'the fixture company did not survive the migration').toBe(true);
    });
});

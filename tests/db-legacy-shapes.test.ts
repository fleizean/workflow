// D-14: each pinned v1.x shape renders the schema its historical database/db.js produced; on a full clone the pins are
// re-derived from every commit of that file. Expected counts are restated, never imported from the generator.

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { repoRoot } from './helpers/ts-imports';
import { cleanupFixtures, schemaOf } from './fixtures/seed';
import {
    LEGACY_CORPUS,
    LEGACY_VARIANTS,
    SHAPES,
    buildLegacyFixture,
    cleanupLegacyFixtures
} from './fixtures/legacy-shapes';
import type { LegacyShapeId, LegacyVariant } from './fixtures/legacy-shapes';

const SHAPE_IDS: readonly LegacyShapeId[] = ['A', 'B', 'C'];
const REAL_SCHEMA = path.join(repoRoot, 'tests', 'fixtures', 'v121-real-schema.sql');
const CHILD = path.join(repoRoot, 'tests', 'fixtures', 'historical-init-child.cjs');

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-history-' + tag + '-'));
    tempDirs.push(dir);
    return dir;
}

afterAll(() => {
    cleanupLegacyFixtures();
    cleanupFixtures();
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function readOnly<T>(dbPath: string, read: (db: Database.Database) => T): T {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return read(db);
    } finally {
        db.close();
    }
}

function scalar(dbPath: string, sql: string): number {
    return readOnly(dbPath, (db) => {
        const row = db.prepare<[], { v: number }>(sql).get();
        if (row === undefined || !('v' in row)) {
            throw new Error('scalar(): no column aliased v. Query: ' + sql);
        }
        return row.v;
    });
}

function realSchema(): string {
    const text = fs.readFileSync(REAL_SCHEMA, 'utf8').replace(/\r\n/g, '\n');
    return text.slice(text.indexOf('CREATE TABLE'));
}

describe('D-14: the pinned v1.x shapes', () => {
    it('assigns every database/db.js commit to exactly one of shapes A, B and C', () => {
        expect(Object.keys(SHAPES)).toEqual(SHAPE_IDS);
        expect(SHAPE_IDS.flatMap((id) => SHAPES[id].commits).sort()).toEqual([
            '0546800', '290aa7b', '4d4b899', '7d620e5', '8fb6823', '9e2f419', 'cc6166e', 'f74e263'
        ]);
        for (const id of SHAPE_IDS) {
            expect(Object.keys(SHAPES[id].settingsSeeded)).toEqual(SHAPES[id].commits);
        }
        expect(new Set(SHAPE_IDS.map((id) => SHAPES[id].expectedSchema)).size).toBe(3);
    });

    it.each(SHAPE_IDS)('renders shape %s through its ALTER path to the pinned schema', (id) => {
        expect(schemaOf(buildLegacyFixture(id, 'empty'))).toBe(SHAPES[id].expectedSchema);
        expect(schemaOf(buildLegacyFixture(id))).toBe(SHAPES[id].expectedSchema);
    });

    it('pins shape C to tests/fixtures/v121-real-schema.sql byte for byte', () => {
        expect(SHAPES.C.expectedSchema).toBe(realSchema());
        expect(schemaOf(buildLegacyFixture('C'))).toBe(realSchema());
    });
});

const EXPECTED_SETTINGS: Readonly<Record<LegacyShapeId, number>> = { A: 4, B: 4, C: 13 };

const EXPECTED_ROWS: Readonly<Record<LegacyVariant, { companies: number; sessions: number; seconds: number }>> = {
    empty: { companies: 0, sessions: 0, seconds: 0 },
    'single-session': { companies: 2, sessions: 1, seconds: 3600 },
    representative: { companies: 2, sessions: 3, seconds: 9000 },
    anomalies: { companies: 2, sessions: 9, seconds: 12030.5 },
    big: { companies: 2, sessions: 2500, seconds: 150000 }
};

describe('D-14: the legacy corpus', () => {
    it('holds every shape x variant and the four seed fixtures, under unique ids', () => {
        expect(LEGACY_CORPUS.map((entry) => entry.id)).toEqual([
            ...SHAPE_IDS.flatMap((shape) => LEGACY_VARIANTS.map((variant) => shape + '/' + variant)),
            'seed/clean', 'seed/wal', 'seed/empty', 'seed/orphan'
        ]);
        expect(LEGACY_VARIANTS).toEqual(['representative', 'empty', 'single-session', 'anomalies', 'big']);
    });

    it.each(LEGACY_CORPUS)('builds $id with its shape\'s schema and a clean integrity_check', async (entry) => {
        const fx = await entry.build();
        expect(readOnly(fx, (db) => db.pragma('integrity_check', { simple: true }))).toBe('ok');
        expect(schemaOf(fx)).toBe(SHAPES[entry.shape].expectedSchema);
    });

    const cases = SHAPE_IDS.flatMap((shape) => LEGACY_VARIANTS.map((variant) => ({ shape, variant })));

    it.each(cases)('seeds $shape/$variant with the specified rows', ({ shape, variant }) => {
        const fx = buildLegacyFixture(shape, variant);
        const expected = EXPECTED_ROWS[variant];
        expect(scalar(fx, 'SELECT count(*) AS v FROM companies')).toBe(expected.companies);
        expect(scalar(fx, 'SELECT count(*) AS v FROM work_sessions')).toBe(expected.sessions);
        expect(scalar(fx, 'SELECT COALESCE(sum(duration), 0) AS v FROM work_sessions')).toBe(expected.seconds);
        expect(scalar(fx, 'SELECT count(*) AS v FROM settings')).toBe(variant === 'empty' ? 0 : EXPECTED_SETTINGS[shape]);
    });

    it.each(SHAPE_IDS)('keeps duplicates as two rows and one session without a company (shape %s)', (shape) => {
        const fx = buildLegacyFixture(shape, 'representative');
        expect(scalar(
            fx,
            'SELECT count(*) AS v FROM (SELECT 1 FROM work_sessions ' +
                'GROUP BY name, duration, date, company_id, note, created_at HAVING count(*) = 2)'
        )).toBe(1);
        expect(scalar(fx, 'SELECT count(*) AS v FROM work_sessions WHERE company_id IS NULL')).toBe(1);
    });

    it.each(SHAPE_IDS)('carries an orphan, three malformed dates and two invalid durations (shape %s)', (shape) => {
        const fx = buildLegacyFixture(shape, 'anomalies');
        expect(scalar(
            fx,
            'SELECT count(*) AS v FROM work_sessions w WHERE w.company_id IS NOT NULL ' +
                'AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = w.company_id)'
        )).toBe(1);
        expect(scalar(fx, "SELECT count(*) AS v FROM work_sessions WHERE date IN ('2026-1-5', '', '05/01/2026')")).toBe(3);
        expect(scalar(
            fx,
            'SELECT count(*) AS v FROM work_sessions WHERE duration < 0 OR duration <> CAST(duration AS INTEGER)'
        )).toBe(2);
    });

    it('gives shape C a pomodoro row for its cascade proofs', () => {
        expect(scalar(buildLegacyFixture('C'), 'SELECT count(*) AS v FROM pomodoro_sessions')).toBe(1);
    });

    it.each(SHAPE_IDS)('makes the big shape-%s fixture larger than 100 pages, so a backup kill lands mid-copy', (shape) => {
        const fx = buildLegacyFixture(shape, 'big');
        expect(readOnly(fx, (db) => db.pragma('page_count', { simple: true }))).toBeGreaterThan(100);
    });
});

function git(args: readonly string[]): string {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function isFullClone(): boolean {
    try {
        return git(['rev-parse', '--is-shallow-repository']).trim() === 'false';
    } catch {
        return false;
    }
}

interface HistoricalRun {
    commit: string;
    crInSource: boolean;
    schema: string;
    settings: { key: string; value: string }[];
    unassigned: number;
}

// Executes the commit's own initDatabase() in a child with electron stubbed to a mkdtemp userData.
function runHistoricalInit(commit: string): HistoricalRun {
    const source = execFileSync('git', ['cat-file', 'blob', commit + ':database/db.js'], { cwd: repoRoot });
    const dbJs = path.join(tempDir('code'), 'db.js');
    fs.writeFileSync(dbJs, source);
    const userData = tempDir('userdata');

    const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const run = spawnSync(process.execPath, [CHILD, dbJs, userData], { env, encoding: 'utf8', timeout: 30_000 });
    if (run.status !== 0 || run.stdout.trim() !== '{"ok":true}') {
        throw new Error(
            'historical initDatabase() at ' + commit + ' exited ' + String(run.status) + ': ' + run.stderr
        );
    }

    const dbPath = path.join(userData, 'krono.db');
    return {
        commit,
        crInSource: source.includes(13),
        schema: schemaOf(dbPath),
        settings: readOnly(dbPath, (db) =>
            db.prepare<[], { key: string; value: string }>('SELECT key, value FROM settings ORDER BY rowid').all()),
        unassigned: scalar(dbPath, "SELECT count(*) AS v FROM companies WHERE name = 'Unassigned'")
    };
}

const historyAvailable = isFullClone();
const HISTORY_TITLE = 're-derives the pinned shapes from every commit of database/db.js' +
    (historyAvailable ? '' : ' (skipped: shallow clone, the history walk runs on full clones only)');

describe('D-14: re-derivation from git history', () => {
    it.skipIf(!historyAvailable)(HISTORY_TITLE, () => {
        const pinned = SHAPE_IDS.flatMap((id) => SHAPES[id].commits.map((sha) => ({ sha, id })));
        const commits = git(['log', '--format=%H', '--follow', '--diff-filter=d', '--', 'database/db.js'])
            .trim()
            .split('\n');
        const pinOf = (commit: string): { sha: string; id: LegacyShapeId } | undefined =>
            pinned.find((pin) => commit.startsWith(pin.sha));

        expect(commits.map((commit) => pinOf(commit)?.sha ?? commit).sort()).toEqual(pinned.map((pin) => pin.sha).sort());

        const runs = commits.map(runHistoricalInit);
        expect(new Set(runs.map((run) => run.schema))).toEqual(new Set(SHAPE_IDS.map((id) => SHAPES[id].expectedSchema)));

        for (const run of runs) {
            const pin = pinOf(run.commit);
            if (pin === undefined) throw new Error('unpinned commit ' + run.commit);
            const shape = SHAPES[pin.id];
            const seeded = shape.settingsSeeded[pin.sha];
            expect(seeded, run.commit).toBeDefined();
            expect(run.schema, run.commit).toBe(shape.expectedSchema);
            expect(run.settings, run.commit).toEqual(
                Object.entries(shape.settings).slice(0, seeded).map(([key, value]) => ({ key, value }))
            );
            expect(run.unassigned, run.commit).toBe(1);
            // Most historical blobs are CRLF, but template literals normalize CRLF, so sqlite_master never saw a CR.
            expect(run.schema, run.commit).not.toContain('\r');
        }
        expect(runs.filter((run) => run.crInSource).length).toBeGreaterThan(0);
    }, 120_000);
});

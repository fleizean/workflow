// D-23/SC1: every corpus fixture survives the real chain (probe -> classify -> backup -> baseline -> v2) with its
// content intact, differing only where v1.2.1's own initDatabase() would, and backed up before the first statement.

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabase, readDatabaseStats, verifyBackup } from '../src/lib/db/backup';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import type { MigrationOptions, MigrationReport } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import { cleanupFixtures, copyFixture } from './fixtures/seed';
import { LEGACY_CORPUS, buildLegacyFixture, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
import { V121_DEFAULT_SETTINGS, executeV121Init } from './helpers/v121-sql';
import {
    captureInvariants,
    diffInvariants,
    originalColumns,
    predictAdoption,
    streakOn
} from './helpers/db-invariants';
import type { LocalDate } from '@shared/utils/date';

const TODAY = '2026-01-06' as LocalDate;
const NOW = new Date(2026, 5, 1, 9, 0, 0);

// Restated from each generator's own rows, never imported from it: a table that imported the split could only
// prove the generator agrees with itself.
interface Expected {
    readonly companies: number;
    readonly workSessions: number;
    readonly settings: number;
    readonly pomodoroSessions: number | null;
    readonly totalDuration: number;
}

const EXPECTED_BEFORE: Readonly<Record<string, Expected>> = {
    'A/representative': { companies: 2, workSessions: 3, settings: 4, pomodoroSessions: null, totalDuration: 9000 },
    'A/empty': { companies: 0, workSessions: 0, settings: 0, pomodoroSessions: null, totalDuration: 0 },
    'A/single-session': { companies: 2, workSessions: 1, settings: 4, pomodoroSessions: null, totalDuration: 3600 },
    'A/anomalies': { companies: 2, workSessions: 9, settings: 4, pomodoroSessions: null, totalDuration: 12030.5 },
    'A/big': { companies: 2, workSessions: 2500, settings: 4, pomodoroSessions: null, totalDuration: 150000 },
    'B/representative': { companies: 2, workSessions: 3, settings: 4, pomodoroSessions: null, totalDuration: 9000 },
    'B/empty': { companies: 0, workSessions: 0, settings: 0, pomodoroSessions: null, totalDuration: 0 },
    'B/single-session': { companies: 2, workSessions: 1, settings: 4, pomodoroSessions: null, totalDuration: 3600 },
    'B/anomalies': { companies: 2, workSessions: 9, settings: 4, pomodoroSessions: null, totalDuration: 12030.5 },
    'B/big': { companies: 2, workSessions: 2500, settings: 4, pomodoroSessions: null, totalDuration: 150000 },
    'C/representative': { companies: 2, workSessions: 3, settings: 13, pomodoroSessions: 1, totalDuration: 9000 },
    'C/empty': { companies: 0, workSessions: 0, settings: 0, pomodoroSessions: 0, totalDuration: 0 },
    'C/single-session': { companies: 2, workSessions: 1, settings: 13, pomodoroSessions: 0, totalDuration: 3600 },
    'C/anomalies': { companies: 2, workSessions: 9, settings: 13, pomodoroSessions: 1, totalDuration: 12030.5 },
    'C/big': { companies: 2, workSessions: 2500, settings: 13, pomodoroSessions: 0, totalDuration: 150000 },
    'seed/clean': { companies: 3, workSessions: 4, settings: 2, pomodoroSessions: 0, totalDuration: 32400 },
    'seed/wal': { companies: 2, workSessions: 45, settings: 0, pomodoroSessions: 0, totalDuration: 22000 },
    'seed/empty': { companies: 0, workSessions: 0, settings: 0, pomodoroSessions: 0, totalDuration: 0 },
    'seed/orphan': { companies: 2, workSessions: 4, settings: 2, pomodoroSessions: 0, totalDuration: 32400 }
};

// Fixture strings a diff message must never carry (T-01-37).
const PRIVATE_STRINGS = ['Northwind Fixture', 'Contoso Fixture', 'Fixture task', 'Morning block', 'Loose block'];

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-migrate-' + tag + '-'));
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

const backupsIn = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.bak')).sort() : [];

const userVersionOf = (dbPath: string): unknown => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return db.pragma('user_version', { simple: true });
    } finally {
        db.close();
    }
};

// Probes and classifies exactly as startup will; no steps and no baseline are passed, so the production
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
            now: NOW,
            ...extra
        });
    } finally {
        closeDatabase(db);
    }
}

// What v1.2.1's own initDatabase() would make of the same file, on an independent copy.
function oracleOf(dbPath: string): string {
    const copy = copyFixture(dbPath);
    const db = openDatabase(copy);
    try {
        executeV121Init(db);
    } finally {
        closeDatabase(db);
    }
    return copy;
}

function freshDatabase(tag: string): string {
    return path.join(tempDir(tag), 'krono.db');
}

describe('D-23/SC1: every corpus fixture reaches LATEST with its tracked time intact', () => {
    it.each(LEGACY_CORPUS.map((entry) => [entry.id, entry] as const))(
        '%s survives the real chain, differing only where v1.2.1 itself would',
        async (id, entry) => {
            const fixture = copyFixture(await entry.build());
            const expected = EXPECTED_BEFORE[id];
            expect(expected, 'every corpus entry needs restated expectations').toBeDefined();
            if (expected === undefined) return;

            const before = captureInvariants(fixture);
            expect(before.counts.companies, id + ' companies before').toBe(expected.companies);
            expect(before.counts.work_sessions, id + ' work_sessions before').toBe(expected.workSessions);
            expect(before.counts.settings, id + ' settings before').toBe(expected.settings);
            expect(before.counts.pomodoro_sessions, id + ' pomodoro_sessions before')
                .toBe(expected.pomodoroSessions);
            expect(before.totalDuration, id + ' sum(duration) before').toBe(expected.totalDuration);

            const oracle = oracleOf(fixture);
            const report = await migrateReal(fixture);

            expect(report.applied).toEqual([1, 2]);
            expect(report.toVersion).toBe(LATEST);
            expect(userVersionOf(fixture)).toBe(LATEST);

            const over = originalColumns(before);
            const after = captureInvariants(fixture, { over });

            // The only differences are the ones D-13 predicts, and each is predicted explicitly.
            expect(diffInvariants(predictAdoption(before), after), id).toEqual([]);

            // sum(duration) and the day totals are untouched, by exact equality.
            expect(after.totalDuration, id + ' sum(duration) after').toBe(expected.totalDuration);
            expect(after.dayTotals).toEqual(before.dayTotals);

            // Independently: the end state is what v1.2.1's own init would have produced.
            const oracleAfter = captureInvariants(oracle, { over });
            expect(after.settings, id + ' settings vs the v1.2.1 oracle').toEqual(oracleAfter.settings);
            expect(after.counts.companies).toBe(oracleAfter.counts.companies);
            expect(after.counts.work_sessions).toBe(oracleAfter.counts.work_sessions);
            expect(after.tables.work_sessions?.digest, id + ' work_sessions vs the v1.2.1 oracle')
                .toBe(oracleAfter.tables.work_sessions?.digest);

            expect(streakOn(after, TODAY), id + ' streak').toBe(streakOn(before, TODAY));
        },
        120_000
    );

    it('a missing krono.db initializes to exactly what v1.2.1 produces', async () => {
        const dbPath = freshDatabase('fresh');
        const oracle = freshDatabase('fresh-oracle');

        const oracleDb = openDatabase(oracle);
        try {
            executeV121Init(oracleDb);
        } finally {
            closeDatabase(oracleDb);
        }

        const report = await migrateReal(dbPath);
        expect(report.dbClass).toBe('fresh');
        expect(report.applied).toEqual([1, 2]);
        expect(report.backupPath, 'a fresh install has nothing to back up').toBeNull();

        const after = captureInvariants(dbPath);
        expect(after.counts.companies, 'the Unassigned company').toBe(1);
        expect(after.counts.work_sessions).toBe(0);
        expect(after.counts.settings).toBe(13);
        expect(after.totalDuration).toBe(0);
        expect(after.settings).toEqual(captureInvariants(oracle).settings);
    });
});

describe('D-23 edge cases', () => {
    it('all-empty tables with zero settings rows end at exactly v1.2.1\'s 13 defaults', async () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'empty'));
        const before = captureInvariants(fixture);
        expect(before.counts.companies).toBe(0);
        expect(before.counts.work_sessions).toBe(0);
        expect(before.counts.settings, 'the empty variant seeds no settings at all').toBe(0);

        await migrateReal(fixture);
        const after = captureInvariants(fixture, { over: originalColumns(before) });

        expect(diffInvariants(predictAdoption(before), after)).toEqual([]);
        expect(after.counts.work_sessions, 'an empty table migrates to an empty table').toBe(0);
        expect(after.counts.companies, 'only the Unassigned row is added').toBe(1);
        expect(after.settings).toEqual(Object.fromEntries(V121_DEFAULT_SETTINGS.map(([k, v]) => [k, v])));
        expect(after.totalDuration).toBe(0);
    });

    it('a single session survives with its duration an exact integer', async () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'single-session'));
        const before = captureInvariants(fixture);
        expect(before.counts.work_sessions).toBe(1);
        expect(before.totalDuration).toBe(3600);

        await migrateReal(fixture);
        const after = captureInvariants(fixture, { over: originalColumns(before) });

        expect(diffInvariants(predictAdoption(before), after)).toEqual([]);
        expect(after.counts.work_sessions).toBe(1);
        expect(after.totalDuration).toBe(3600);
        expect(Number.isInteger(after.totalDuration), 'sum(duration) stays a SQLite INTEGER').toBe(true);
        expect(typeof after.totalDuration).toBe('number');
    });

    it('two sessions with identical content remain two rows', async () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'representative'));
        const before = captureInvariants(fixture);
        const sessions = before.tables.work_sessions;
        expect(sessions).not.toBeNull();

        // The generator writes two rows differing only in their primary key; both must survive.
        const withoutId = (sessions?.rows ?? []).map((row) => row.slice(1).join('|'));
        const duplicated = withoutId.filter((row, index) => withoutId.indexOf(row) !== index);
        expect(duplicated.length, 'the fixture must contain a duplicate pair for this to prove anything')
            .toBeGreaterThan(0);

        await migrateReal(fixture);
        const after = captureInvariants(fixture, { over: originalColumns(before) });

        expect(diffInvariants(predictAdoption(before), after)).toEqual([]);
        expect(after.counts.work_sessions).toBe(before.counts.work_sessions);
        expect(after.tables.work_sessions?.rows.length).toBe(sessions?.rows.length);
    });

    it('the primary key is part of the digest, so a lost row cannot be masked by an equal one', () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'representative'));
        const full = captureInvariants(fixture);

        const db = new Database(fixture);
        try {
            // Delete one of the two identical-content sessions: only the primary key distinguishes them.
            db.prepare('DELETE FROM work_sessions WHERE id = (SELECT max(id) FROM work_sessions WHERE name = ?)')
                .run('Morning block');
        } finally {
            db.close();
        }

        const reduced = captureInvariants(fixture);
        expect(reduced.tables.work_sessions?.digest).not.toBe(full.tables.work_sessions?.digest);
        expect(diffInvariants(full, reduced).length).toBeGreaterThan(0);
    });
});

describe('SC1/DATA-03: a verified backup exists before the first migration statement', () => {
    it.each(['A', 'B', 'C'] as const)(
        'shape %s is backed up and verified before the baseline transaction runs',
        async (shape) => {
            const fixture = copyFixture(buildLegacyFixture(shape, 'representative'));
            const backupDir = path.join(path.dirname(fixture), 'backups');
            const expected = readDatabaseStats(fixture);
            const seen: { version: number; backups: string[] }[] = [];

            const report = await migrateReal(fixture, {
                backupDir,
                hooks: {
                    insideTransaction: (version) => {
                        seen.push({ version, backups: backupsIn(backupDir) });
                    }
                }
            });

            const first = seen[0];
            expect(first?.version, 'the baseline is the first transaction').toBe(1);
            expect(first?.backups, 'the backup exists before the first statement').toHaveLength(1);
            expect(report.backupPath).toBe(path.join(backupDir, first?.backups[0] ?? ''));
            expect(verifyBackup(report.backupPath ?? ''), 'the backup matches the pre-migration source')
                .toEqual(expected);
        }
    );

    it('prunes to the three newest backups, this run\'s included, after the chain commits', async () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'representative'));
        const backupDir = path.join(path.dirname(fixture), 'backups');
        for (let day = 1; day <= 4; day++) {
            await backupDatabase(fixture, backupDir, { now: new Date(2026, 0, day, 9, 0, 0) });
        }
        const older = backupsIn(backupDir);
        expect(older).toHaveLength(4);

        const report = await migrateReal(fixture, { backupDir });

        const left = backupsIn(backupDir);
        expect(left).toHaveLength(3);
        expect(left).toContain(path.basename(report.backupPath ?? ''));
        expect(left, 'the two oldest are the ones pruned')
            .toEqual(expect.arrayContaining([older[2], older[3]]));
        expect(report.pruned.map((file) => path.basename(file)).sort()).toEqual([older[0], older[1]]);
    });

    it('a database already at LATEST takes no backup and applies nothing', async () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'representative'));
        await migrateReal(fixture);
        const migrated = captureInvariants(fixture);

        const again = await migrateReal(fixture);

        expect(again.dbClass).toBe('current');
        expect(again.applied).toEqual([]);
        expect(again.backupPath).toBeNull();
        expect(again.pruned).toEqual([]);
        expect(diffInvariants(migrated, captureInvariants(fixture))).toEqual([]);
    });
});

describe('D-23: the streak is recomputed from day totals, and survives the migration', () => {
    function sessionsAt(days: readonly string[], duration: number, settings: readonly [string, string][]): string {
        const dbPath = freshDatabase('streak');
        const db = openDatabase(dbPath);
        try {
            executeV121Init(db);
            const insert = db.prepare<[string, number, string, string]>(
                'INSERT INTO work_sessions (name, duration, date, created_at) VALUES (?, ?, ?, ?)'
            );
            for (const day of days) {
                insert.run('Streak block', duration, day, '2026-01-05 09:00:00');
            }
            const setting = db.prepare<[string, string]>('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
            for (const [key, value] of settings) setting.run(key, value);
        } finally {
            closeDatabase(db);
        }
        return dbPath;
    }

    it('counts consecutive days that reach the daily target, and stops at the first that does not', () => {
        const dbPath = sessionsAt(['2026-01-06', '2026-01-05', '2026-01-02'], 28800, []);
        const invariants = captureInvariants(dbPath);

        expect(streakOn(invariants, TODAY), 'the 6th and 5th reach it, the 4th and 3rd have nothing').toBe(2);
    });

    it('counts a day below the target as breaking the streak', () => {
        const dbPath = sessionsAt(['2026-01-06', '2026-01-05'], 3600, []);
        expect(streakOn(captureInvariants(dbPath), TODAY)).toBe(0);
    });

    it('skips weekends when exclude_weekends_from_streak is true', () => {
        // 2026-01-10 and 11 are a Saturday and a Sunday; the streak must reach across them.
        const monday = '2026-01-12' as LocalDate;
        const dbPath = sessionsAt(['2026-01-12', '2026-01-09', '2026-01-08'], 28800, [
            ['exclude_weekends_from_streak', 'true']
        ]);
        const invariants = captureInvariants(dbPath);

        expect(streakOn(invariants, monday)).toBe(3);

        const counted = sessionsAt(['2026-01-12', '2026-01-09', '2026-01-08'], 28800, [
            ['exclude_weekends_from_streak', 'false']
        ]);
        expect(streakOn(captureInvariants(counted), monday), 'the weekend gap breaks it when counted').toBe(1);
    });

    it('survives the migration on a fixture whose sessions reach the target', async () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'representative'));
        const db = new Database(fixture);
        try {
            const insert = db.prepare(
                'INSERT INTO work_sessions (name, duration, date, company_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            );
            insert.run('Target day', 28800, '2026-01-06', 2, 'Fixture task: target', '2026-01-06 09:00:00');
            insert.run('Target day', 28800, '2026-01-05', 2, 'Fixture task: target', '2026-01-05 09:00:00');
        } finally {
            db.close();
        }

        const before = captureInvariants(fixture);
        expect(streakOn(before, TODAY), 'the fixture must have a real streak for this to prove anything')
            .toBeGreaterThan(0);

        await migrateReal(fixture);
        const after = captureInvariants(fixture, { over: originalColumns(before) });

        expect(streakOn(after, TODAY)).toBe(streakOn(before, TODAY));
        expect(diffInvariants(predictAdoption(before), after)).toEqual([]);
    });
});

describe('T-01-37: a difference names tables and columns, never a row value', () => {
    it('reports a changed row without quoting it', () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'representative'));
        const before = captureInvariants(fixture);

        const db = new Database(fixture);
        try {
            db.prepare('UPDATE work_sessions SET note = ? WHERE id = ?').run('a secret note value', 1);
        } finally {
            db.close();
        }

        const differences = diffInvariants(before, captureInvariants(fixture));
        expect(differences.length).toBeGreaterThan(0);
        const reported = differences.join(' | ');
        expect(reported).toContain('work_sessions');
        expect(reported).not.toContain('a secret note value');
        for (const secret of PRIVATE_STRINGS) {
            expect(reported, reported).not.toContain(secret);
        }
    });
});

// Guards the helper itself: a capture that silently digested a different column set would hide a loss.
describe('the invariant helper refuses to compare a different column set', () => {
    it('throws when an original column is gone', () => {
        const fixture = copyFixture(buildLegacyFixture('C', 'representative'));
        const before = captureInvariants(fixture);
        const over = { ...originalColumns(before), companies: ['id', 'name', 'nonexistent_column'] };

        expect(() => captureInvariants(fixture, { over })).toThrow(/lost 1 original column/);
    });

    it('reports an absent table rather than skipping it', () => {
        const shapeA = captureInvariants(copyFixture(buildLegacyFixture('A', 'representative')));
        expect(shapeA.tables.pomodoro_sessions, 'shape A has no pomodoro_sessions').toBeNull();
        expect(shapeA.counts.pomodoro_sessions).toBeNull();
    });
});

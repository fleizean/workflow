// CORE-01 / CORE-16: one repository per table, camelCase domain objects out, column names in. Every fixture is built
// under mkdtemp by the Phase 4 helpers and run through the production migration chain before a repository sees it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import { createDbHandle, transact } from '../src/lib/db/handle';
import {
    SETTINGS_KEY_MAP, createCompaniesRepository, createPomodoroRepository, createSessionsRepository,
    createSettingsRepository
} from '../src/lib/db/repositories';
import type { SkippedRow } from '../src/lib/db/repositories';
import { DEFAULT_SETTINGS } from '../src/shared/constants/settings';
import { buildLegacyFixture, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
import { cleanupFixtures, makeCleanFixture, makeEmptyFixture } from './fixtures/seed';
import type { LocalDate, Settings } from '../src/shared/types';

const ld = (text: string): LocalDate => text as LocalDate;

interface Opened {
    readonly connection: DatabaseType.Database;
    readonly handle: ReturnType<typeof createDbHandle>;
    readonly skipped: SkippedRow[];
    readonly dbPath: string;
}

const opened: DatabaseType.Database[] = [];

// The production chain, exactly as startup runs it, then the handle the composition root will build.
async function open(dbPath: string): Promise<Opened> {
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    const connection = openDatabase(dbPath);
    opened.push(connection);
    await migrateDatabase(connection, {
        dbPath,
        dbClass: classify(probe.observed, LATEST),
        fromVersion: probe.observed.userVersion,
        backupDir: path.join(path.dirname(dbPath), 'backups')
    });
    return { connection, handle: createDbHandle(connection), skipped: [], dbPath };
}

afterAll(() => {
    for (const connection of opened) closeDatabase(connection);
    cleanupLegacyFixtures();
    cleanupFixtures();
});

// Reads the raw table with the driver, bypassing every repository: the only honest way to ask what is on disk.
function rawRows<T>(dbPath: string, query: string): T[] {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return db.prepare<[], T>(query).all();
    } finally {
        db.close();
    }
}

const storedSettings = (dbPath: string): Map<string, string> => new Map(
    rawRows<{ key: string; value: string }>(dbPath, 'SELECT key, value FROM settings')
        .map((row) => [row.key, row.value] as const)
);

describe('CORE-01: the sessions repository', () => {
    let ctx: Opened;

    beforeAll(async () => {
        ctx = await open(makeCleanFixture());
    });

    const repo = () => createSessionsRepository(ctx.handle, { onSkippedRow: (s) => ctx.skipped.push(s) });

    it('returns exactly the WorkSession keys, and no column name among them', () => {
        const [session] = repo().list();
        expect(session, 'the clean fixture has four sessions').toBeDefined();
        expect(Object.keys(session ?? {}).sort())
            .toEqual(['companyId', 'createdAt', 'date', 'durationSeconds', 'id', 'name', 'note']);

        const raw = rawRows<Record<string, unknown>>(ctx.dbPath, 'SELECT * FROM work_sessions LIMIT 1')[0] ?? {};
        const renamed = ['duration', 'company_id', 'created_at'];
        expect(renamed.every((column) => column in raw), 'the fixture must carry the columns this test renames')
            .toBe(true);
        expect(renamed.filter((column) => column in (session ?? {})),
            'CORE-01: a database column name reached a caller').toEqual([]);
    });

    it('maps duration to whole seconds and created_at to an epoch instant', () => {
        const morning = repo().list().find((s) => s.name === 'Morning block');
        expect(morning?.durationSeconds).toBe(14400);
        expect(morning?.date).toBe('2026-01-05');
        expect(morning?.note).toBe('Fixture task: morning block');
        expect(morning?.createdAt, 'created_at is UTC text in the database and epoch ms in the domain')
            .toBe(Date.UTC(2026, 0, 5, 9, 0, 0));
    });

    it('lists a date range inclusively and a date-plus-company pair', () => {
        expect(repo().listByDateRange(ld('2026-01-05'), ld('2026-01-06')).map((s) => s.date).sort())
            .toEqual(['2026-01-05', '2026-01-05', '2026-01-06']);
        expect(repo().listByDateAndCompany(ld('2026-01-05'), 2).map((s) => s.name).sort())
            .toEqual(['Afternoon block', 'Morning block']);
    });

    it('totals each local day from all of its sessions, not from the longest one (B7)', () => {
        expect(repo().dayTotals()).toEqual([
            { date: '2026-01-07', totalSeconds: 1800 },
            { date: '2026-01-06', totalSeconds: 10800 },
            { date: '2026-01-05', totalSeconds: 19800 }
        ]);
    });

    it('creates, updates and deletes through the domain shape', () => {
        const created = repo().create({
            name: 'Added block', durationSeconds: 900, date: ld('2026-01-09'), companyId: 2, note: null
        });
        expect(created.id).toBeGreaterThan(0);
        expect(created.durationSeconds).toBe(900);
        expect(created.createdAt, 'the column default fills created_at, so it stays readable').toBeGreaterThan(0);

        const updated = repo().update(created.id, {
            name: 'Added block', durationSeconds: 1200, date: ld('2026-01-09'), companyId: 2, note: 'edited'
        });
        expect(updated?.durationSeconds).toBe(1200);
        expect(updated?.note).toBe('edited');
        expect(repo().update(999_999, {
            name: 'x', durationSeconds: 1, date: ld('2026-01-09'), companyId: null, note: null
        }), 'a missing row is null, not a throw').toBeNull();

        expect(repo().remove(created.id)).toBe(true);
        expect(repo().remove(created.id), 'the second delete changes nothing').toBe(false);
        expect(repo().get(created.id)).toBeNull();
    });

    it('counts nothing for a company that has no sessions', () => {
        expect(repo().removeByCompany(999_999)).toBe(0);
    });
});

describe('DATA-05: an empty database totals to nothing rather than null', () => {
    it('returns no day totals, no sessions and every setting at its seed', async () => {
        const ctx = await open(makeEmptyFixture());
        const repo = createSessionsRepository(ctx.handle);
        expect(repo.list()).toEqual([]);
        expect(repo.dayTotals(), 'sum() over no rows is NULL; a total must never render as "null"').toEqual([]);
        expect(createSettingsRepository(ctx.handle).get()).toEqual(DEFAULT_SETTINGS);
    });
});

describe('D-15: a row the domain cannot use is reported, never guessed at and never fatal', () => {
    let ctx: Opened;
    const skipped: SkippedRow[] = [];

    beforeAll(async () => {
        ctx = await open(buildLegacyFixture('C', 'anomalies'));
    });

    it('returns every session it can map and reports the rest by column and id', () => {
        const sessions = createSessionsRepository(ctx.handle, { onSkippedRow: (s) => skipped.push(s) }).list();
        const stored = rawRows<{ c: number }>(ctx.dbPath, 'SELECT count(*) AS c FROM work_sessions')[0]?.c ?? 0;

        expect(stored, 'the anomalies fixture seeds nine sessions').toBe(9);
        expect(sessions.map((s) => s.name).sort())
            .toEqual(['Loose block', 'Morning block', 'Morning block', 'Orphaned block']);
        expect(skipped.map((s) => s.column).sort(), 'three malformed dates and two impossible durations')
            .toEqual(['date', 'date', 'date', 'duration', 'duration']);
        expect(skipped.every((s) => s.table === 'work_sessions' && typeof s.rowId === 'number')).toBe(true);
        expect(JSON.stringify(skipped), 'a report must never carry a session name or a note')
            .not.toMatch(/Odd date|Blank date|US date|Fixture task/);
    });

    it('leaves an unusable day out of the totals rather than inventing one', () => {
        expect(createSessionsRepository(ctx.handle).dayTotals()).toEqual([
            { date: '2026-01-07', totalSeconds: 1200 },
            { date: '2026-01-06', totalSeconds: 1800 },
            { date: '2026-01-05', totalSeconds: 7200 }
        ]);
    });

    it('keeps every row on disk: nothing is repaired and nothing is deleted', () => {
        createSessionsRepository(ctx.handle).list();
        expect(rawRows<{ c: number }>(ctx.dbPath, 'SELECT count(*) AS c FROM work_sessions')[0]?.c).toBe(9);
    });
});

describe('CORE-01: the companies repository', () => {
    let ctx: Opened;

    beforeAll(async () => {
        ctx = await open(makeCleanFixture());
    });

    it('returns exactly the Company keys and never the export columns', () => {
        const companies = createCompaniesRepository(ctx.handle).list();
        expect(companies.map((c) => c.name)).toEqual(['Contoso Fixture', 'Northwind Fixture', 'Unassigned']);
        for (const company of companies) {
            expect(Object.keys(company).sort()).toEqual(['createdAt', 'id', 'name', 'noteRequired']);
        }
        expect(JSON.stringify(companies), 'the retired export letters must not travel with a company')
            .not.toMatch(/excel|note_column/i);
    });

    it('reads note_required as a boolean and created_at as an instant', () => {
        const repo = createCompaniesRepository(ctx.handle);
        const northwind = repo.findByName('Northwind Fixture');
        expect(northwind?.noteRequired).toBe(true);
        expect(northwind?.createdAt).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
        expect(repo.findByName('Unassigned')?.noteRequired).toBe(false);
        expect(repo.findByName('No Such Fixture')).toBeNull();
    });

    it('an update touches name and note_required only, and leaves the export letters where they are', () => {
        const repo = createCompaniesRepository(ctx.handle);
        const before = rawRows<{ id: number; excel_column: string | null }>(
            ctx.dbPath, 'SELECT id, excel_column FROM companies WHERE name = ' + "'Northwind Fixture'"
        )[0];
        expect(before?.excel_column, 'the fixture must carry the data this test is about').toBe('B');

        const updated = repo.update(before?.id ?? 0, { name: 'Northwind Renamed', noteRequired: false });
        expect(updated?.name).toBe('Northwind Renamed');
        expect(updated?.noteRequired).toBe(false);

        const after = rawRows<{ excel_column: string | null; updated_at: string }>(
            ctx.dbPath, 'SELECT excel_column, updated_at FROM companies WHERE name = ' + "'Northwind Renamed'"
        )[0];
        expect(after?.excel_column, 'V2-SCHEMA-01: the data stays until a migration deliberately removes it').toBe('B');
        expect(after?.updated_at, 'v1.2.1 bumped updated_at on every company update').not.toBe('2026-01-01 09:00:00');

        repo.update(before?.id ?? 0, { name: 'Northwind Fixture', noteRequired: true });
        expect(repo.update(999_999, { name: 'x', noteRequired: false }), 'a missing row is null').toBeNull();
    });

    it('creates and deletes, and one transaction takes the sessions with the company', () => {
        const companies = createCompaniesRepository(ctx.handle);
        const sessions = createSessionsRepository(ctx.handle);
        const created = companies.create({ name: 'Temp Fixture', noteRequired: false });
        expect(created.noteRequired).toBe(false);
        sessions.create({
            name: 'Temp block', durationSeconds: 60, date: ld('2026-01-10'), companyId: created.id, note: null
        });

        const removedSessions = transact(ctx.handle, () => {
            const count = sessions.removeByCompany(created.id);
            companies.remove(created.id);
            return count;
        });

        expect(removedSessions, 'COMP-05: the caller learns what went with the company').toBe(1);
        expect(companies.get(created.id)).toBeNull();
    });
});

describe('CORE-01: the settings repository', () => {
    let ctx: Opened;

    beforeAll(async () => {
        ctx = await open(makeCleanFixture());
    });

    it('maps exactly the ten domain keys onto the v1.2.1 key strings', () => {
        expect(Object.keys(SETTINGS_KEY_MAP).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
        const mapped = Object.values(SETTINGS_KEY_MAP);
        expect(mapped, 'the retired export keys must not be mapped').not.toContain('script_url');
        expect(mapped).not.toContain('export_half_hour_precision');
        expect(Object.keys(createSettingsRepository(ctx.handle).get()).sort())
            .toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    });

    it('reads the stored rows, and a missing row as its v1.2.1 seed', () => {
        expect(createSettingsRepository(ctx.handle).get().dailyTargetSeconds, 'the stored daily_target').toBe(28800);

        // The baseline replay seeds every v1.2.1 key, so the fallback needs a row taken away to be proven at all.
        ctx.connection.exec('DELETE FROM settings WHERE key = ' + "'pomodoro_short_break'");
        expect(rawRows<{ c: number }>(ctx.dbPath, 'SELECT count(*) AS c FROM settings')[0]?.c).toBe(12);
        expect(createSettingsRepository(ctx.handle).get().pomodoroShortBreakSeconds)
            .toBe(DEFAULT_SETTINGS.pomodoroShortBreakSeconds);
    });

    it('writes only the keys in the patch, in the string form v1.2.1 wrote', () => {
        const repo = createSettingsRepository(ctx.handle);
        const before = storedSettings(ctx.dbPath);
        const after = repo.update({ dailyTargetSeconds: 14400, pomodoroEnabled: true });
        expect(after.dailyTargetSeconds).toBe(14400);
        expect(after.pomodoroEnabled).toBe(true);
        expect(after.goalNotification, 'an untouched key keeps its value').toBe(DEFAULT_SETTINGS.goalNotification);

        const rows = storedSettings(ctx.dbPath);
        expect(rows.get('daily_target'), 'the database keeps the v1.2.1 string form').toBe('14400');
        expect(rows.get('pomodoro_enabled')).toBe('true');

        const changed = [...rows].filter(([key, value]) => before.get(key) !== value).map(([key]) => key).sort();
        expect(changed, 'a settings write must touch nothing the patch did not name')
            .toEqual(['daily_target', 'pomodoro_enabled']);
        expect([...rows.keys()].sort(), 'and must add no row either').toEqual([...before.keys()].sort());
    });

    it('a value the domain cannot use reads as its seed instead of making settings unreadable', () => {
        const write = ctx.connection.prepare<[string, string]>(
            'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
        );
        write.run('pomodoro_work_duration', 'not a number');
        write.run('goal_notification', 'yes');
        const stored = createSettingsRepository(ctx.handle).get();
        expect(stored.pomodoroWorkSeconds).toBe(DEFAULT_SETTINGS.pomodoroWorkSeconds);
        expect(stored.goalNotification).toBe(DEFAULT_SETTINGS.goalNotification);
    });

    it('survives a legacy NULL primary key, which SQLite reports as notnull 0 (04-08)', () => {
        ctx.connection.exec('INSERT INTO settings (key, value) VALUES (NULL, ' + "'orphaned'" + ')');
        expect(rawRows<{ c: number }>(ctx.dbPath, 'SELECT count(*) AS c FROM settings WHERE key IS NULL')[0]?.c,
            'the fixture must actually hold the NULL key this test is about').toBe(1);
        const stored: Settings = createSettingsRepository(ctx.handle).get();
        expect(Object.keys(stored).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    });

    it('never reads or writes the rows the retired export left behind', () => {
        const url = 'https://script.google.com/macros/s/AKfycbxRetained/exec';
        ctx.connection.prepare<[string, string]>('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
            .run('script_url', url);
        createSettingsRepository(ctx.handle).update({ dailyTargetSeconds: 28800 });
        expect(storedSettings(ctx.dbPath).get('script_url'), 'SC4: a settings write rewrote a row nothing reads')
            .toBe(url);
        expect(JSON.stringify(createSettingsRepository(ctx.handle).get())).not.toMatch(/script|google/i);
    });
});

describe('CORE-01: the pomodoro repository', () => {
    it('counts a local day from its rows and records a completion', async () => {
        const ctx = await open(buildLegacyFixture('C', 'representative'));
        const repo = createPomodoroRepository(ctx.handle);

        expect(repo.countForDay(ld('2026-01-05')), 'the fixture row carries pomodoros_completed 2').toBe(2);
        expect(repo.countForDay(ld('2026-01-04')), 'a day with no rows is zero, never null').toBe(0);

        const recorded = repo.recordCompletion(ld('2026-01-04'), null);
        expect(Object.keys(recorded).sort()).toEqual(['companyId', 'date', 'id', 'pomodorosCompleted']);
        expect(recorded.pomodorosCompleted).toBe(1);
        expect(recorded.companyId).toBeNull();
        expect(repo.countForDay(ld('2026-01-04'))).toBe(1);
        expect(repo.listByDate(ld('2026-01-05')).map((p) => p.pomodorosCompleted)).toEqual([2]);
    });
});

// The retired export columns and settings keys, as the SQL a repository issues would spell them.
const RETIRED = ['excel_column', 'note_column', 'script_url', 'export_half_hour_precision'];

describe('SC4: no repository asks the database for a retired column', () => {
    it('names none of them in any statement it issues', async () => {
        const migrated = await open(makeCleanFixture());
        closeDatabase(migrated.connection);

        // openDatabase's statement trace is the only way to see the SQL itself; the mapper alone would hide a
        // SELECT * that fetched the columns and then dropped them.
        const issued: string[] = [];
        const connection = openDatabase(migrated.dbPath, { verbose: (message) => issued.push(String(message)) });
        opened.push(connection);
        const handle = createDbHandle(connection);
        const companies = createCompaniesRepository(handle);
        const sessions = createSessionsRepository(handle);
        const settings = createSettingsRepository(handle);
        const pomodoro = createPomodoroRepository(handle);

        const company = companies.list()[0];
        companies.get(company?.id ?? 1);
        companies.findByName('Unassigned');
        const temp = companies.create({ name: 'Traced Insert', noteRequired: true });
        companies.update(temp.id, { name: 'Traced Insert', noteRequired: false });
        sessions.list();
        sessions.listByDateRange(ld('2026-01-01'), ld('2026-01-31'));
        sessions.listByDateAndCompany(ld('2026-01-05'), company?.id ?? 1);
        sessions.dayTotals();
        settings.get();
        settings.update({ dailyTargetSeconds: 28800 });
        pomodoro.countForDay(ld('2026-01-05'));
        pomodoro.listByDate(ld('2026-01-05'));

        expect(issued.length, 'the trace must have seen the statements it is asked to judge').toBeGreaterThan(10);
        expect(issued.some((statement) => statement.includes('note_required')),
            'negative control: the trace does see the column names a repository legitimately uses').toBe(true);

        const named = issued.filter((statement) => RETIRED.some((column) => statement.includes(column)));
        const reads = named.filter((statement) => /^s*(select|update|delete)/i.test(statement));
        expect(reads, 'SC4: a repository read or wrote a column the app no longer has any use for').toEqual([]);

        // What is left is drizzle's INSERT, which enumerates every column schema.ts declares and passes the default.
        // The repository supplies no value for either retired column and reads neither back, so a new company gets
        // the SQL NULL a plain INSERT INTO companies (name, note_required) would have left there anyway.
        expect(named.every((statement) => statement.startsWith('insert into "companies"')),
            'a statement other than the companies insert named a retired column: ' + named.join(' | ')).toBe(true);
        const created = rawRows<{ excel_column: string | null; note_column: string | null }>(
            migrated.dbPath, 'SELECT excel_column, note_column FROM companies WHERE name = ' + "'Traced Insert'"
        )[0];
        expect(created, 'the traced insert must have produced a row').toBeDefined();
        expect(created?.excel_column).toBeNull();
        expect(created?.note_column).toBeNull();
    });
});

describe('CORE-16: the repository layer is one file per table plus its mapper', () => {
    it('holds exactly the files the barrel re-exports', () => {
        expect(fs.readdirSync('src/lib/db/repositories').sort()).toEqual([
            'companies.repository.ts', 'index.ts', 'pomodoro.repository.ts', 'rows.ts',
            'sessions.repository.ts', 'settings.repository.ts'
        ]);
    });
});

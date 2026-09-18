// v1.x krono.db shapes, each reached through that version's own CREATE + ALTER path (D-14), built only under mkdtemp.
// Statement text is copied byte for byte from database/db.js history: sqlite_master stores it verbatim.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { makeCleanFixture, makeEmptyFixture, makeOrphanFixture, makeWalFixture } from './seed';

export type LegacyShapeId = 'A' | 'B' | 'C';
export type LegacyVariant = 'representative' | 'empty' | 'single-session' | 'anomalies' | 'big';

export interface LegacyShape {
    // Every database/db.js commit whose initDatabase() leaves this schema, and how many settings it seeded.
    readonly commits: readonly string[];
    readonly settingsSeeded: Readonly<Record<string, number>>;
    readonly createStatements: readonly string[];
    readonly alterStatements: readonly string[];
    readonly settings: Readonly<Record<string, string>>;
    readonly expectedSchema: string;
}

export interface LegacyCorpusEntry {
    readonly id: string;
    readonly shape: LegacyShapeId;
    readonly variant: LegacyVariant | 'seed-clean' | 'seed-wal' | 'seed-empty' | 'seed-orphan';
    readonly build: () => Promise<string>;
}

const CREATE_COMPANIES = `
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

const CREATE_WORK_SESSIONS = `
    CREATE TABLE IF NOT EXISTS work_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

const CREATE_SETTINGS = `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;

const CREATE_POMODORO_SESSIONS = `
    CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      company_id INTEGER,
      pomodoros_completed INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    )
  `;

const ALTER_WORK_SESSIONS = [
    'ALTER TABLE work_sessions ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE',
    'ALTER TABLE work_sessions ADD COLUMN note TEXT'
] as const;

const ALTER_COMPANIES_EXPORT = [
    'ALTER TABLE companies ADD COLUMN excel_column TEXT',
    'ALTER TABLE companies ADD COLUMN note_column TEXT'
] as const;

const ALTER_COMPANIES_NOTE_REQUIRED = 'ALTER TABLE companies ADD COLUMN note_required INTEGER DEFAULT 0';

const EARLY_SETTINGS = {
    daily_target: '28800',
    goal_notification: 'true',
    start_reminder: 'false',
    haptic_feedback: 'true'
} as const;

const V121_SETTINGS = {
    ...EARLY_SETTINGS,
    exclude_weekends_from_streak: 'false',
    pomodoro_enabled: 'false',
    pomodoro_work_duration: '1500',
    pomodoro_short_break: '300',
    pomodoro_long_break: '900',
    pomodoro_sessions_until_long_break: '4',
    pomodoro_auto_start_breaks: 'true',
    pomodoro_auto_start_work: 'false',
    export_half_hour_precision: 'false'
} as const;

const SCHEMA_A = `CREATE TABLE companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE sqlite_sequence(name,seq);

CREATE TABLE work_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    , company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, note TEXT);
`;

const SCHEMA_B = `CREATE TABLE companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    , excel_column TEXT, note_column TEXT);

CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE sqlite_sequence(name,seq);

CREATE TABLE work_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    , company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, note TEXT);
`;

const SCHEMA_C = `CREATE TABLE companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    , excel_column TEXT, note_column TEXT, note_required INTEGER DEFAULT 0);

CREATE TABLE pomodoro_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      company_id INTEGER,
      pomodoros_completed INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE sqlite_sequence(name,seq);

CREATE TABLE work_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    , company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, note TEXT);
`;

// Derived by running every commit's own initDatabase() (tests/db-legacy-shapes.test.ts re-derives it on full clones).
export const SHAPES: Readonly<Record<LegacyShapeId, LegacyShape>> = {
    A: {
        commits: ['9e2f419', '4d4b899', 'f74e263'],
        settingsSeeded: { '9e2f419': 4, '4d4b899': 4, f74e263: 4 },
        createStatements: [CREATE_COMPANIES, CREATE_WORK_SESSIONS, CREATE_SETTINGS],
        alterStatements: [...ALTER_WORK_SESSIONS],
        settings: EARLY_SETTINGS,
        expectedSchema: SCHEMA_A
    },
    B: {
        commits: ['0546800', 'cc6166e'],
        settingsSeeded: { '0546800': 4, cc6166e: 4 },
        createStatements: [CREATE_COMPANIES, CREATE_WORK_SESSIONS, CREATE_SETTINGS],
        alterStatements: [...ALTER_WORK_SESSIONS, ...ALTER_COMPANIES_EXPORT],
        settings: EARLY_SETTINGS,
        expectedSchema: SCHEMA_B
    },
    C: {
        commits: ['290aa7b', '7d620e5', '8fb6823'],
        settingsSeeded: { '290aa7b': 12, '7d620e5': 13, '8fb6823': 13 },
        createStatements: [CREATE_COMPANIES, CREATE_WORK_SESSIONS, CREATE_SETTINGS, CREATE_POMODORO_SESSIONS],
        alterStatements: [...ALTER_WORK_SESSIONS, ...ALTER_COMPANIES_EXPORT, ALTER_COMPANIES_NOTE_REQUIRED],
        settings: V121_SETTINGS,
        expectedSchema: SCHEMA_C
    }
};

export const LEGACY_VARIANTS: readonly LegacyVariant[] = ['representative', 'empty', 'single-session', 'anomalies', 'big'];

// Sessions in the 'big' variant: enough 200-character notes to pass PAGES_PER_STEP (100) pages (D-24).
const BIG_SESSIONS = 2500;

const created: string[] = [];

function freshDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-legacy-' + tag + '-'));
    created.push(dir);
    return dir;
}

export function cleanupLegacyFixtures(): void {
    while (created.length > 0) {
        const dir = created.pop();
        if (dir === undefined) continue;
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            /* a lingering Windows handle; the OS cleans temp */
        }
    }
}

function seedVariant(db: Database.Database, shape: LegacyShape, variant: LegacyVariant): void {
    if (variant === 'empty') return;

    const insertCompany = db.prepare('INSERT INTO companies (name, created_at, updated_at) VALUES (?, ?, ?)');
    const company = (name: string): number | bigint =>
        insertCompany.run(name, '2026-01-01 09:00:00', '2026-01-01 09:00:00').lastInsertRowid;
    const insertSession = db.prepare(
        'INSERT INTO work_sessions (name, duration, date, company_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const session = (name: string, duration: number, date: string, companyId: number | bigint | null): void => {
        insertSession.run(name, duration, date, companyId, 'Fixture task: ' + name.toLowerCase(), '2026-01-05 09:00:00');
    };

    company('Unassigned');
    const northwind = company('Northwind Fixture');

    if (variant === 'single-session') {
        session('Morning block', 3600, '2026-01-05', northwind);
    } else if (variant === 'big') {
        db.transaction(() => {
            for (let i = 0; i < BIG_SESSIONS; i++) {
                const note = ('Fixture bulk note ' + String(i) + ' ').padEnd(200, 'x');
                const day = '2026-01-' + String((i % 28) + 1).padStart(2, '0');
                insertSession.run('Bulk block ' + String(i), 60, day, northwind, note, '2026-01-05 09:00:00');
            }
        })();
    } else {
        // Duplicates must stay two rows; the NULL-company row is what D-13's reassignment is measured on.
        session('Morning block', 3600, '2026-01-05', northwind);
        session('Morning block', 3600, '2026-01-05', northwind);
        session('Loose block', 1800, '2026-01-06', null);
        if (shape.createStatements.includes(CREATE_POMODORO_SESSIONS)) {
            db.prepare('INSERT INTO pomodoro_sessions (date, company_id, pomodoros_completed, created_at) VALUES (?, ?, ?, ?)')
                .run('2026-01-05', northwind, 2, '2026-01-05 10:00:00');
        }
        if (variant === 'anomalies') {
            const contoso = company('Contoso Fixture');
            session('Orphaned block', 1200, '2026-01-07', contoso);
            // What a third-party tool does: enforcement off on its own connection, then delete (see seed.ts).
            db.pragma('foreign_keys = OFF');
            db.prepare('DELETE FROM companies WHERE id = ?').run(contoso);
            db.pragma('foreign_keys = ON');
            session('Odd date', 600, '2026-1-5', northwind);
            session('Blank date', 600, '', northwind);
            session('US date', 600, '05/01/2026', northwind);
            session('Negative block', -60, '2026-01-08', northwind);
            session('Fractional block', 90.5, '2026-01-08', northwind);
        }
    }

    const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(shape.settings)) {
        insertSetting.run(key, value);
    }
}

export function buildLegacyFixture(shape: LegacyShapeId, variant: LegacyVariant = 'representative'): string {
    const spec = SHAPES[shape];
    const dbPath = path.join(freshDir(shape.toLowerCase() + '-' + variant), 'krono.db');
    const db = new Database(dbPath);
    try {
        db.pragma('journal_mode = WAL');
        for (const sql of spec.createStatements) db.exec(sql);
        for (const sql of spec.alterStatements) db.exec(sql);
        seedVariant(db, spec, variant);
        db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
        db.close();
    }
    return dbPath;
}

// Every shape x variant, plus seed.ts's fixtures (all v1.2.1 DDL; cleaned by its own cleanupFixtures).
export const LEGACY_CORPUS: readonly LegacyCorpusEntry[] = [
    ...(Object.keys(SHAPES) as LegacyShapeId[]).flatMap((shape) =>
        LEGACY_VARIANTS.map((variant): LegacyCorpusEntry => ({
            id: shape + '/' + variant,
            shape,
            variant,
            build: () => Promise.resolve(buildLegacyFixture(shape, variant))
        }))
    ),
    { id: 'seed/clean', shape: 'C', variant: 'seed-clean', build: () => Promise.resolve(makeCleanFixture()) },
    { id: 'seed/wal', shape: 'C', variant: 'seed-wal', build: makeWalFixture },
    { id: 'seed/empty', shape: 'C', variant: 'seed-empty', build: () => Promise.resolve(makeEmptyFixture()) },
    { id: 'seed/orphan', shape: 'C', variant: 'seed-orphan', build: () => Promise.resolve(makeOrphanFixture()) }
];

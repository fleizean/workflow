// v1.x krono.db shapes, each reached through that version's own CREATE + ALTER path (D-14), built only under mkdtemp.
// Statement text is copied byte for byte from database/db.js history: sqlite_master stores it verbatim.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export type LegacyShapeId = 'A';
export type LegacyVariant = 'representative';

export interface LegacyShape {
    readonly commits: readonly string[];
    readonly createStatements: readonly string[];
    readonly alterStatements: readonly string[];
    readonly settings: Readonly<Record<string, string>>;
    readonly expectedSchema: string;
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

const ALTER_WORK_SESSIONS = [
    'ALTER TABLE work_sessions ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE',
    'ALTER TABLE work_sessions ADD COLUMN note TEXT'
] as const;

const EARLY_SETTINGS = {
    daily_target: '28800',
    goal_notification: 'true',
    start_reminder: 'false',
    haptic_feedback: 'true'
} as const;

export const SHAPES: Readonly<Record<LegacyShapeId, LegacyShape>> = {
    A: {
        commits: ['9e2f419', 'f74e263'],
        createStatements: [CREATE_COMPANIES, CREATE_WORK_SESSIONS, CREATE_SETTINGS],
        alterStatements: [...ALTER_WORK_SESSIONS],
        settings: EARLY_SETTINGS,
        expectedSchema: `CREATE TABLE companies (
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
`
    }
};

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

// Two identical Northwind sessions and one with no company: 9000 seconds in all.
function seedRepresentative(db: Database.Database, shape: LegacyShape): void {
    const insertCompany = db.prepare('INSERT INTO companies (name, created_at, updated_at) VALUES (?, ?, ?)');
    insertCompany.run('Unassigned', '2026-01-01 09:00:00', '2026-01-01 09:00:00');
    const northwind = insertCompany.run('Northwind Fixture', '2026-01-01 09:00:00', '2026-01-01 09:00:00').lastInsertRowid;

    const insertSession = db.prepare(
        'INSERT INTO work_sessions (name, duration, date, company_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insertSession.run('Morning block', 3600, '2026-01-05', northwind, 'Fixture task: morning block', '2026-01-05 09:00:00');
    insertSession.run('Morning block', 3600, '2026-01-05', northwind, 'Fixture task: morning block', '2026-01-05 09:00:00');
    insertSession.run('Loose block', 1800, '2026-01-06', null, 'Fixture task: loose block', '2026-01-06 09:00:00');

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
        seedRepresentative(db, spec);
        db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
        db.close();
    }
    return dbPath;
}

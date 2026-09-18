// D-13: v1.2.1's initDatabase() replayed verbatim, so a fresh install and an adopted database reach one schema text.
// It issues no transaction control and no user_version write - the runner owns both.

import type DatabaseType from 'better-sqlite3';

// The raw v1.2.1 strings, not src/shared DEFAULT_SETTINGS (camelCase, typed, and a different key set).
const V121_DEFAULT_SETTINGS: readonly (readonly [string, string])[] = Object.freeze([
    ['daily_target', '28800'],
    ['goal_notification', 'true'],
    ['start_reminder', 'false'],
    ['haptic_feedback', 'true'],
    ['exclude_weekends_from_streak', 'false'],
    ['pomodoro_enabled', 'false'],
    ['pomodoro_work_duration', '1500'],
    ['pomodoro_short_break', '300'],
    ['pomodoro_long_break', '900'],
    ['pomodoro_sessions_until_long_break', '4'],
    ['pomodoro_auto_start_breaks', 'true'],
    ['pomodoro_auto_start_work', 'false'],
    ['export_half_hour_precision', 'false']
] as const);

// Statement text and control flow are database/db.js's own; whitespace is part of the contract, because
// sqlite_master stores CREATE text verbatim.
export function applyV121Baseline(db: DatabaseType.Database): void {
    db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

    db.exec(`
    CREATE TABLE IF NOT EXISTS work_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

    const sessionColumns = db.prepare<[], { name: string }>('PRAGMA table_info(work_sessions)')
        .all().map((column) => column.name);

    if (!sessionColumns.includes('company_id')) {
        db.exec('ALTER TABLE work_sessions ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE');
    }

    if (!sessionColumns.includes('note')) {
        db.exec('ALTER TABLE work_sessions ADD COLUMN note TEXT');
    }

    const companyColumns = db.prepare<[], { name: string }>('PRAGMA table_info(companies)')
        .all().map((column) => column.name);

    if (!companyColumns.includes('excel_column')) {
        db.exec('ALTER TABLE companies ADD COLUMN excel_column TEXT');
    }

    if (!companyColumns.includes('note_column')) {
        db.exec('ALTER TABLE companies ADD COLUMN note_column TEXT');
    }

    if (!companyColumns.includes('note_required')) {
        db.exec('ALTER TABLE companies ADD COLUMN note_required INTEGER DEFAULT 0');
    }

    const existing = db.prepare<[], { id: number }>("SELECT id FROM companies WHERE name = 'Unassigned'").get();
    if (existing === undefined) {
        db.prepare("INSERT INTO companies (name) VALUES ('Unassigned')").run();
    }

    // db.js reads the row a second time and reassigns only NULL company ids.
    const unassigned = db.prepare<[], { id: number }>("SELECT id FROM companies WHERE name = 'Unassigned'").get();
    if (unassigned !== undefined) {
        db.prepare<[number]>('UPDATE work_sessions SET company_id = ? WHERE company_id IS NULL').run(unassigned.id);
    }

    db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

    db.exec(`
    CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      company_id INTEGER,
      pomodoros_completed INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    )
  `);

    const insertSetting = db.prepare<[string, string]>('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of V121_DEFAULT_SETTINGS) {
        insertSetting.run(key, value);
    }
}

// v1.2.1's own SQL, transcribed from database/db.js and pinned to it by tests/db-v121-transcription.test.ts (D-13, D-26).
// Whitespace is part of the contract: sqlite_master stores CREATE text verbatim, trailing spaces included.

import type DatabaseType from 'better-sqlite3';

export interface V121InitStatement {
    readonly id: string;
    readonly via: 'exec' | 'prepare';
    readonly sql: string;
    // database/db.js runs the ALTERs only when its PRAGMA table_info read shows the column is absent.
    readonly guard?: { readonly table: string; readonly column: string };
}

export interface V121DowngradeResult {
    readonly ok: boolean;
    // Each entry names the statement and the error; never a row value (T-01-37).
    readonly failures: readonly string[];
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

// initDatabase() in source order. The two Unassigned SELECTs are both present: db.js reads the row twice.
export const V121_INIT: readonly V121InitStatement[] = [
    { id: 'create-companies', via: 'exec', sql: CREATE_COMPANIES },
    { id: 'create-work-sessions', via: 'exec', sql: CREATE_WORK_SESSIONS },
    { id: 'table-info-work-sessions', via: 'prepare', sql: 'PRAGMA table_info(work_sessions)' },
    {
        id: 'alter-company-id',
        via: 'exec',
        sql: 'ALTER TABLE work_sessions ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE',
        guard: { table: 'work_sessions', column: 'company_id' }
    },
    {
        id: 'alter-note',
        via: 'exec',
        sql: 'ALTER TABLE work_sessions ADD COLUMN note TEXT',
        guard: { table: 'work_sessions', column: 'note' }
    },
    { id: 'table-info-companies', via: 'prepare', sql: 'PRAGMA table_info(companies)' },
    {
        id: 'alter-excel-column',
        via: 'exec',
        sql: 'ALTER TABLE companies ADD COLUMN excel_column TEXT',
        guard: { table: 'companies', column: 'excel_column' }
    },
    {
        id: 'alter-note-column',
        via: 'exec',
        sql: 'ALTER TABLE companies ADD COLUMN note_column TEXT',
        guard: { table: 'companies', column: 'note_column' }
    },
    {
        id: 'alter-note-required',
        via: 'exec',
        sql: 'ALTER TABLE companies ADD COLUMN note_required INTEGER DEFAULT 0',
        guard: { table: 'companies', column: 'note_required' }
    },
    { id: 'select-unassigned', via: 'prepare', sql: "SELECT id FROM companies WHERE name = 'Unassigned'" },
    { id: 'insert-unassigned', via: 'prepare', sql: "INSERT INTO companies (name) VALUES ('Unassigned')" },
    { id: 'select-unassigned-id', via: 'prepare', sql: "SELECT id FROM companies WHERE name = 'Unassigned'" },
    {
        id: 'update-null-company',
        via: 'prepare',
        sql: 'UPDATE work_sessions SET company_id = ? WHERE company_id IS NULL'
    },
    { id: 'create-settings', via: 'exec', sql: CREATE_SETTINGS },
    { id: 'create-pomodoro-sessions', via: 'exec', sql: CREATE_POMODORO_SESSIONS },
    { id: 'insert-setting', via: 'prepare', sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)' }
];

// The raw v1.2.1 strings, NOT src/shared DEFAULT_SETTINGS (camelCase, typed, and a different key set).
export const V121_DEFAULT_SETTINGS: readonly (readonly [string, string])[] = [
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
];

// Every other literal database/db.js hands the driver, keyed by the function that holds it.
export const V121_STATEMENTS: Readonly<Record<string, readonly string[]>> = {
    journalMode: ['journal_mode = WAL'],
    saveSession: ['INSERT INTO work_sessions (name, duration, date, company_id, note) VALUES (?, ?, ?, ?, ?)'],
    getSessions: ['SELECT * FROM work_sessions ORDER BY created_at DESC'],
    getSessionsByDateRange: ['SELECT * FROM work_sessions WHERE date BETWEEN ? AND ? ORDER BY date DESC'],
    updateSession: [
        'UPDATE work_sessions SET name = ?, duration = ?, date = ?, company_id = ?, note = ? WHERE id = ?'
    ],
    deleteSession: ['DELETE FROM work_sessions WHERE id = ?'],
    deleteAllSessions: ['DELETE FROM work_sessions'],
    createCompany: ['INSERT INTO companies (name, note_required) VALUES (?, ?)'],
    getCompanies: ['SELECT * FROM companies ORDER BY name ASC'],
    getCompany: ['SELECT * FROM companies WHERE id = ?'],
    updateCompany: [
        'UPDATE companies SET name = ?, excel_column = ?, note_column = ?, note_required = ?, ' +
        'updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ],
    updateCompanyExcelConfig: [
        'UPDATE companies SET excel_column = ?, note_column = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ],
    getTodaySessions: [`
        SELECT 
            ws.id,
            ws.name,
            ws.duration,
            ws.date,
            ws.note,
            ws.company_id,
            c.name as company_name,
            c.excel_column,
            c.note_column
        FROM work_sessions ws
        LEFT JOIN companies c ON ws.company_id = c.id
        WHERE ws.date = ?
        ORDER BY c.name ASC, ws.created_at ASC
    `],
    getTodaysSessionsSummary: [`
        SELECT 
            c.id as company_id,
            c.name as company_name,
            c.excel_column,
            c.note_column,
            SUM(ws.duration) as total_duration,
            GROUP_CONCAT(ws.note, ' | ') as combined_notes
        FROM work_sessions ws
        LEFT JOIN companies c ON ws.company_id = c.id
        WHERE ws.date = ?
        GROUP BY ws.company_id
        ORDER BY c.name ASC
    `],
    getSessionsSummaryByDate: [`
        SELECT 
            c.id as company_id,
            c.name as company_name,
            c.excel_column,
            c.note_column,
            SUM(ws.duration) as total_duration,
            GROUP_CONCAT(ws.note, ' | ') as combined_notes
        FROM work_sessions ws
        LEFT JOIN companies c ON ws.company_id = c.id
        WHERE ws.date = ?
        GROUP BY ws.company_id
        ORDER BY c.name ASC
    `],
    deleteCompany: [
        'DELETE FROM work_sessions WHERE company_id = ?',
        'DELETE FROM companies WHERE id = ?'
    ],
    getSessionsGroupedByDateAndCompany: [`
        SELECT 
            ws.date,
            ws.company_id,
            c.name as company_name,
            SUM(ws.duration) as total_duration,
            COUNT(ws.id) as session_count,
            GROUP_CONCAT(ws.id) as session_ids
        FROM work_sessions ws
        LEFT JOIN companies c ON ws.company_id = c.id
        GROUP BY ws.date, ws.company_id
        ORDER BY ws.date DESC, c.name ASC
    `],
    getSessionsByDateAndCompany: [`
        SELECT ws.*, c.name as company_name
        FROM work_sessions ws
        LEFT JOIN companies c ON ws.company_id = c.id
        WHERE ws.date = ? AND ws.company_id = ?
        ORDER BY ws.created_at ASC
    `],
    getSetting: ['SELECT value FROM settings WHERE key = ?'],
    setSetting: ['INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'],
    getThisWeekTotal: ['SELECT SUM(duration) as total FROM work_sessions WHERE date BETWEEN ? AND ?'],
    getLastWeekTotal: ['SELECT SUM(duration) as total FROM work_sessions WHERE date BETWEEN ? AND ?'],
    calculateCurrentStreak: [`
        SELECT date, SUM(duration) as total_duration
        FROM work_sessions
        GROUP BY date
        ORDER BY date DESC
    `],
    savePomodoroCompletion: ['INSERT INTO pomodoro_sessions (date, company_id, pomodoros_completed) VALUES (?, ?, 1)'],
    getTodayPomodoroCount: ['SELECT SUM(pomodoros_completed) as total FROM pomodoro_sessions WHERE date = ?'],
    getPomodoroStatsByDate: [`
        SELECT 
            c.name as company_name,
            SUM(ps.pomodoros_completed) as pomodoros
        FROM pomodoro_sessions ps
        LEFT JOIN companies c ON ps.company_id = c.id
        WHERE ps.date = ?
        GROUP BY ps.company_id
        ORDER BY pomodoros DESC
    `],
    getWeeklyPomodoroStats: [`
        SELECT 
            date,
            SUM(pomodoros_completed) as total
        FROM pomodoro_sessions
        WHERE date >= ? AND date <= ?
        GROUP BY date
        ORDER BY date ASC
    `]
};

const INIT_BY_ID = new Map(V121_INIT.map((entry) => [entry.id, entry]));

function sqlOf(id: string): string {
    const found = INIT_BY_ID.get(id);
    if (found === undefined) {
        throw new Error('v121-sql: no init statement ' + id);
    }
    return found.sql;
}

function statement(name: string, index = 0): string {
    const found = V121_STATEMENTS[name]?.[index];
    if (found === undefined) {
        throw new Error('v121-sql: no statement ' + name + '[' + String(index) + ']');
    }
    return found;
}

function columnNames(db: DatabaseType.Database, sql: string): string[] {
    return db.prepare<[], { name: string }>(sql).all().map((row) => row.name);
}

// Replays initDatabase() with db.js's own control flow: the ALTERs stay guarded by their table_info read.
export function executeV121Init(db: DatabaseType.Database): void {
    db.exec(sqlOf('create-companies'));
    db.exec(sqlOf('create-work-sessions'));

    const sessionColumns = columnNames(db, sqlOf('table-info-work-sessions'));
    if (!sessionColumns.includes('company_id')) db.exec(sqlOf('alter-company-id'));
    if (!sessionColumns.includes('note')) db.exec(sqlOf('alter-note'));

    const companyColumns = columnNames(db, sqlOf('table-info-companies'));
    if (!companyColumns.includes('excel_column')) db.exec(sqlOf('alter-excel-column'));
    if (!companyColumns.includes('note_column')) db.exec(sqlOf('alter-note-column'));
    if (!companyColumns.includes('note_required')) db.exec(sqlOf('alter-note-required'));

    const existing = db.prepare<[], { id: number }>(sqlOf('select-unassigned')).get();
    if (existing === undefined) {
        db.prepare(sqlOf('insert-unassigned')).run();
    }

    const unassigned = db.prepare<[], { id: number }>(sqlOf('select-unassigned-id')).get();
    if (unassigned !== undefined) {
        db.prepare<[number]>(sqlOf('update-null-company')).run(unassigned.id);
    }

    db.exec(sqlOf('create-settings'));
    db.exec(sqlOf('create-pomodoro-sessions'));

    const insertSetting = db.prepare<[string, string]>(sqlOf('insert-setting'));
    for (const [key, value] of V121_DEFAULT_SETTINGS) {
        insertSetting.run(key, value);
    }
}

// D-26: v1.2.1's own statements against a database this milestone has migrated. Writes must read back.
export function runV121Downgrade(db: DatabaseType.Database, today: string): V121DowngradeResult {
    const failures: string[] = [];
    const attempt = (name: string, run: () => void): void => {
        try {
            run();
        } catch (error) {
            failures.push(name + ': ' + (error instanceof Error ? error.message : String(error)));
        }
    };

    const rangeStart = '2026-01-01';
    const rangeEnd = '2026-12-31';
    let companyId = 0;
    let sessionId = 0;

    attempt('journal_mode', () => {
        db.pragma(statement('journalMode'));
    });
    attempt('initDatabase', () => {
        executeV121Init(db);
    });

    // Every statement parses against the migrated schema, including the three this probe must not run.
    attempt('prepare every transcribed statement', () => {
        for (const [name, statements] of Object.entries(V121_STATEMENTS)) {
            if (name === 'journalMode') continue;
            for (const sql of statements) db.prepare(sql);
        }
    });

    attempt('saveSession', () => {
        const unassigned = db.prepare<[], { id: number }>(sqlOf('select-unassigned')).get();
        if (unassigned === undefined) {
            throw new Error('the Unassigned company is missing after initDatabase');
        }
        const info = db.prepare<[string, number, string, number, string]>(statement('saveSession'))
            .run('Downgrade probe', 1234, today, unassigned.id, 'Downgrade probe note');
        sessionId = Number(info.lastInsertRowid);
        const rows = db.prepare<[], { id: number; duration: number }>(statement('getSessions')).all();
        if (!rows.some((row) => row.id === sessionId && row.duration === 1234)) {
            throw new Error('the saved session did not read back');
        }
    });

    attempt('createCompany', () => {
        const info = db.prepare<[string, number]>(statement('createCompany')).run('Downgrade Probe Co', 1);
        companyId = Number(info.lastInsertRowid);
        const row = db.prepare<[number], { name: string }>(statement('getCompany')).get(companyId);
        if (row?.name !== 'Downgrade Probe Co') {
            throw new Error('the created company did not read back');
        }
    });

    attempt('updateCompany', () => {
        db.prepare<[string, string, string, number, number]>(statement('updateCompany'))
            .run('Downgrade Probe Co 2', 'B', 'C', 0, companyId);
        const row = db.prepare<[number], { name: string }>(statement('getCompany')).get(companyId);
        if (row?.name !== 'Downgrade Probe Co 2') {
            throw new Error('the updated company did not read back');
        }
    });

    attempt('updateCompanyExcelConfig', () => {
        db.prepare<[string, string, number]>(statement('updateCompanyExcelConfig')).run('D', 'E', companyId);
        const row = db.prepare<[number], { excel_column: string }>(statement('getCompany')).get(companyId);
        if (row?.excel_column !== 'D') {
            throw new Error('the updated export columns did not read back');
        }
    });

    attempt('setSetting', () => {
        db.prepare<[string, string]>(statement('setSetting')).run('daily_target', '30000');
        const row = db.prepare<[string], { value: string }>(statement('getSetting')).get('daily_target');
        if (row?.value !== '30000') {
            throw new Error('the written setting did not read back');
        }
    });

    attempt('savePomodoroCompletion', () => {
        db.prepare<[string, number]>(statement('savePomodoroCompletion')).run(today, companyId);
        const row = db.prepare<[string], { total: number | null }>(statement('getTodayPomodoroCount')).get(today);
        if ((row?.total ?? 0) < 1) {
            throw new Error('the saved pomodoro did not read back');
        }
    });

    attempt('getSessionsByDateRange', () => {
        db.prepare<[string, string]>(statement('getSessionsByDateRange')).all(today, today);
    });
    attempt('getCompanies', () => {
        db.prepare(statement('getCompanies')).all();
    });
    attempt('getTodaySessions', () => {
        db.prepare<[string]>(statement('getTodaySessions')).all(today);
    });
    attempt('getTodaysSessionsSummary', () => {
        db.prepare<[string]>(statement('getTodaysSessionsSummary')).all(today);
    });
    attempt('getSessionsSummaryByDate', () => {
        db.prepare<[string]>(statement('getSessionsSummaryByDate')).all(today);
    });
    attempt('getSessionsGroupedByDateAndCompany', () => {
        db.prepare(statement('getSessionsGroupedByDateAndCompany')).all();
    });
    attempt('getSessionsByDateAndCompany', () => {
        db.prepare<[string, number]>(statement('getSessionsByDateAndCompany')).all(today, companyId);
    });
    attempt('getThisWeekTotal', () => {
        db.prepare<[string, string]>(statement('getThisWeekTotal')).get(rangeStart, rangeEnd);
    });
    attempt('getLastWeekTotal', () => {
        db.prepare<[string, string]>(statement('getLastWeekTotal')).get(rangeStart, rangeEnd);
    });
    attempt('calculateCurrentStreak', () => {
        db.prepare(statement('calculateCurrentStreak')).all();
    });
    attempt('getPomodoroStatsByDate', () => {
        db.prepare<[string]>(statement('getPomodoroStatsByDate')).all(today);
    });
    attempt('getWeeklyPomodoroStats', () => {
        db.prepare<[string, string]>(statement('getWeeklyPomodoroStats')).all(rangeStart, rangeEnd);
    });

    attempt('deleteCompany', () => {
        db.prepare<[number]>(statement('deleteCompany', 0)).run(companyId);
        db.prepare<[number]>(statement('deleteCompany', 1)).run(companyId);
        const row = db.prepare<[number], { name: string }>(statement('getCompany')).get(companyId);
        if (row !== undefined) {
            throw new Error('the deleted company still reads back');
        }
    });

    return { ok: failures.length === 0, failures };
}

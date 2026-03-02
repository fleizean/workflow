// database/db.js
// SQLite database management for Workflow

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

// Database path in user data directory
const dbPath = path.join(app.getPath('userData'), 'krono.db');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Helper function to format date as YYYY-MM-DD in local timezone
function formatLocalDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Initialize database tables
 */
function initDatabase() {
    // Companies table
    db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

    // Work sessions table
    db.exec(`
    CREATE TABLE IF NOT EXISTS work_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

    // Migration: Add company_id and note columns if they don't exist
    const tableInfo = db.prepare('PRAGMA table_info(work_sessions)').all();
    const hasCompanyId = tableInfo.some(col => col.name === 'company_id');
    const hasNote = tableInfo.some(col => col.name === 'note');

    if (!hasCompanyId) {
        db.exec('ALTER TABLE work_sessions ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE');
    }

    if (!hasNote) {
        db.exec('ALTER TABLE work_sessions ADD COLUMN note TEXT');
    }

    // Migration: Add excel_column and note_column to companies table
    const companyTableInfo = db.prepare('PRAGMA table_info(companies)').all();
    const hasExcelColumn = companyTableInfo.some(col => col.name === 'excel_column');
    const hasNoteColumn = companyTableInfo.some(col => col.name === 'note_column');
    const hasNoteRequired = companyTableInfo.some(col => col.name === 'note_required');

    if (!hasExcelColumn) {
        db.exec('ALTER TABLE companies ADD COLUMN excel_column TEXT');
    }

    if (!hasNoteColumn) {
        db.exec('ALTER TABLE companies ADD COLUMN note_column TEXT');
    }

    if (!hasNoteRequired) {
        db.exec('ALTER TABLE companies ADD COLUMN note_required INTEGER DEFAULT 0');
    }

    // Create default "Unassigned" company if it doesn't exist
    const defaultCompany = db.prepare('SELECT id FROM companies WHERE name = \'Unassigned\'').get();
    if (!defaultCompany) {
        db.prepare('INSERT INTO companies (name) VALUES (\'Unassigned\')').run();
    }

    // Assign existing work sessions without company_id to the default company
    const unassignedCompanyId = db.prepare('SELECT id FROM companies WHERE name = \'Unassigned\'').get()?.id;
    if (unassignedCompanyId) {
        db.prepare('UPDATE work_sessions SET company_id = ? WHERE company_id IS NULL').run(unassignedCompanyId);
    }

    // Settings table
    db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

    // Pomodoro sessions table for tracking completed Pomodoros
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

    // Initialize default settings
    const defaultSettings = {
        daily_target: '28800', // 8 hours in seconds
        goal_notification: 'true',
        start_reminder: 'false',
        haptic_feedback: 'true',
        exclude_weekends_from_streak: 'false',
        // Pomodoro settings
        pomodoro_enabled: 'false',
        pomodoro_work_duration: '1500', // 25 minutes in seconds
        pomodoro_short_break: '300', // 5 minutes in seconds
        pomodoro_long_break: '900', // 15 minutes in seconds
        pomodoro_sessions_until_long_break: '4',
        pomodoro_auto_start_breaks: 'true',
        pomodoro_auto_start_work: 'false',
        export_half_hour_precision: 'false'
    };

    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(defaultSettings)) {
        insertSetting.run(key, value);
    }
}

/**
 * Save a work session
 */
function saveSession(name, duration, date, companyId = null, note = null) {
    const stmt = db.prepare('INSERT INTO work_sessions (name, duration, date, company_id, note) VALUES (?, ?, ?, ?, ?)');
    const result = stmt.run(name, duration, date, companyId, note);
    return result.lastInsertRowid;
}

/**
 * Get all work sessions
 */
function getSessions() {
    const stmt = db.prepare('SELECT * FROM work_sessions ORDER BY created_at DESC');
    return stmt.all();
}

/**
 * Get sessions for a specific date range
 */
function getSessionsByDateRange(startDate, endDate) {
    const stmt = db.prepare('SELECT * FROM work_sessions WHERE date BETWEEN ? AND ? ORDER BY date DESC');
    return stmt.all(startDate, endDate);
}

/**
 * Update a session
 */
function updateSession(id, name, duration, date, companyId = null, note = null) {
    const stmt = db.prepare('UPDATE work_sessions SET name = ?, duration = ?, date = ?, company_id = ?, note = ? WHERE id = ?');
    const result = stmt.run(name, duration, date, companyId, note, id);
    return result.changes > 0;
}

/**
 * Delete a session
 */
function deleteSession(id) {
    const stmt = db.prepare('DELETE FROM work_sessions WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
}

/**
 * Delete all sessions
 */
function deleteAllSessions() {
    const stmt = db.prepare('DELETE FROM work_sessions');
    const result = stmt.run();
    return result.changes;
}

/**
 * Create a new company
 */
function createCompany(name, noteRequired = false) {
    const stmt = db.prepare('INSERT INTO companies (name, note_required) VALUES (?, ?)');
    const result = stmt.run(name, noteRequired ? 1 : 0);
    return result.lastInsertRowid;
}

/**
 * Get all companies
 */
function getCompanies() {
    const stmt = db.prepare('SELECT * FROM companies ORDER BY name ASC');
    return stmt.all();
}

/**
 * Get a single company by ID
 */
function getCompany(id) {
    const stmt = db.prepare('SELECT * FROM companies WHERE id = ?');
    return stmt.get(id);
}

/**
 * Update a company
 */
function updateCompany(id, name, excelColumn = null, noteColumn = null, noteRequired = false) {
    const stmt = db.prepare('UPDATE companies SET name = ?, excel_column = ?, note_column = ?, note_required = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(name, excelColumn, noteColumn, noteRequired ? 1 : 0, id);
    return result.changes > 0;
}

/**
 * Update company Excel configuration only
 */
function updateCompanyExcelConfig(id, excelColumn, noteColumn) {
    const stmt = db.prepare('UPDATE companies SET excel_column = ?, note_column = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(excelColumn, noteColumn, id);
    return result.changes > 0;
}

/**
 * Get today's sessions grouped by company
 */
function getTodaySessions() {
    // Use local date instead of UTC
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const stmt = db.prepare(`
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
    `);
    return stmt.all(today);
}

/**
 * Get today's sessions summary for export (grouped by company)
 */
function getTodaysSessionsSummary() {
    // Use local date instead of UTC
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const stmt = db.prepare(`
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
    `);
    return stmt.all(today);
}

/**
 * Get sessions summary for a specific date (for export)
 */
function getSessionsSummaryByDate(date) {
    const stmt = db.prepare(`
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
    `);
    return stmt.all(date);
}

/**
 * Delete a company (cascade deletes all associated sessions)
 */
function deleteCompany(id) {
    // First delete all associated sessions
    const deleteSessionsStmt = db.prepare('DELETE FROM work_sessions WHERE company_id = ?');
    deleteSessionsStmt.run(id);

    // Then delete the company
    const deleteCompanyStmt = db.prepare('DELETE FROM companies WHERE id = ?');
    const result = deleteCompanyStmt.run(id);
    return result.changes > 0;
}

/**
 * Get sessions grouped by date and company
 */
function getSessionsGroupedByDateAndCompany() {
    const stmt = db.prepare(`
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
    `);
    return stmt.all();
}

/**
 * Get detailed sessions for a specific date and company
 */
function getSessionsByDateAndCompany(date, companyId) {
    const stmt = db.prepare(`
        SELECT ws.*, c.name as company_name
        FROM work_sessions ws
        LEFT JOIN companies c ON ws.company_id = c.id
        WHERE ws.date = ? AND ws.company_id = ?
        ORDER BY ws.created_at ASC
    `);
    return stmt.all(date, companyId);
}

/**
 * Get a setting value
 */
function getSetting(key) {
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const result = stmt.get(key);
    return result ? result.value : null;
}

/**
 * Set a setting value
 */
function setSetting(key, value) {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    stmt.run(key, value);
}

/**
 * Get total duration for this week
 */
function getThisWeekTotal() {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const startDate = formatLocalDate(monday);
    const endDate = formatLocalDate(sunday);

    const stmt = db.prepare('SELECT SUM(duration) as total FROM work_sessions WHERE date BETWEEN ? AND ?');
    const result = stmt.get(startDate, endDate);
    return result.total || 0;
}

/**
 * Get total duration for last week
 */
function getLastWeekTotal() {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const thisMonday = new Date(today);
    thisMonday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(thisMonday.getDate() - 7);
    lastMonday.setHours(0, 0, 0, 0);

    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);
    lastSunday.setHours(23, 59, 59, 999);

    const startDate = formatLocalDate(lastMonday);
    const endDate = formatLocalDate(lastSunday);

    const stmt = db.prepare('SELECT SUM(duration) as total FROM work_sessions WHERE date BETWEEN ? AND ?');
    const result = stmt.get(startDate, endDate);
    return result.total || 0;
}

/**
 * Calculate current streak (consecutive days of reaching daily target)
 */
function calculateCurrentStreak() {
    const dailyTarget = parseInt(getSetting('daily_target') || '28800');
    const excludeWeekends = getSetting('exclude_weekends_from_streak') === 'true';

    // Helper function to check if a date is a weekend
    const isWeekend = (date) => {
        const day = date.getDay();
        return day === 0 || day === 6; // Sunday = 0, Saturday = 6
    };

    // Get all sessions grouped by date, ordered from most recent
    const stmt = db.prepare(`
        SELECT date, SUM(duration) as total_duration
        FROM work_sessions
        GROUP BY date
        ORDER BY date DESC
    `);
    const dailyTotals = stmt.all();

    if (dailyTotals.length === 0) {
        return 0;
    }

    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Check if today has reached the target
    const todayStr = formatLocalDate(today);
    const todayData = dailyTotals.find(d => d.date === todayStr);
    const todayReachedTarget = todayData && todayData.total_duration >= dailyTarget;

    // Start from today if target reached, otherwise from yesterday
    let checkDate = new Date(today);
    if (!todayReachedTarget) {
        checkDate.setDate(checkDate.getDate() - 1);
    }

    // Count backwards to find consecutive days with target reached
    while (true) {
        // Skip weekends if the setting is enabled
        if (excludeWeekends && isWeekend(checkDate)) {
            checkDate.setDate(checkDate.getDate() - 1);
            continue;
        }

        const dateStr = formatLocalDate(checkDate);
        const dayData = dailyTotals.find(d => d.date === dateStr);

        if (dayData && dayData.total_duration >= dailyTarget) {
            streak++;
            checkDate.setDate(checkDate.getDate() - 1);
        } else {
            // If no data for this date or didn't meet target, stop counting
            break;
        }

        // Safety check: don't go back more than 365 days
        const daysDiff = Math.floor((today - checkDate) / (1000 * 60 * 60 * 24));
        if (daysDiff > 365) {
            break;
        }
    }

    return streak;
}

/**
 * Pomodoro Functions
 */

/**
 * Save a completed Pomodoro
 */
function savePomodoroCompletion(date, companyId = null) {
    const stmt = db.prepare('INSERT INTO pomodoro_sessions (date, company_id, pomodoros_completed) VALUES (?, ?, 1)');
    const result = stmt.run(date, companyId);
    return result.lastInsertRowid;
}

/**
 * Get today's total Pomodoro count
 */
function getTodayPomodoroCount() {
    const today = formatLocalDate(new Date());
    const stmt = db.prepare('SELECT SUM(pomodoros_completed) as total FROM pomodoro_sessions WHERE date = ?');
    const result = stmt.get(today);
    return result?.total || 0;
}

/**
 * Get Pomodoro stats for a specific date
 */
function getPomodoroStatsByDate(date) {
    const stmt = db.prepare(`
        SELECT 
            c.name as company_name,
            SUM(ps.pomodoros_completed) as pomodoros
        FROM pomodoro_sessions ps
        LEFT JOIN companies c ON ps.company_id = c.id
        WHERE ps.date = ?
        GROUP BY ps.company_id
        ORDER BY pomodoros DESC
    `);
    return stmt.all(date);
}

/**
 * Get weekly Pomodoro stats
 */
function getWeeklyPomodoroStats() {
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const stmt = db.prepare(`
        SELECT 
            date,
            SUM(pomodoros_completed) as total
        FROM pomodoro_sessions
        WHERE date >= ? AND date <= ?
        GROUP BY date
        ORDER BY date ASC
    `);
    return stmt.all(formatLocalDate(weekAgo), formatLocalDate(today));
}

module.exports = {
    initDatabase,
    saveSession,
    getSessions,
    getSessionsByDateRange,
    updateSession,
    deleteSession,
    deleteAllSessions,
    getSetting,
    setSetting,
    getThisWeekTotal,
    getLastWeekTotal,
    calculateCurrentStreak,
    // Company functions
    createCompany,
    getCompanies,
    getCompany,
    updateCompany,
    updateCompanyExcelConfig,
    deleteCompany,
    getSessionsGroupedByDateAndCompany,
    getSessionsByDateAndCompany,
    // Export functions
    getTodaySessions,
    getTodaysSessionsSummary,
    getSessionsSummaryByDate,
    // Pomodoro functions
    savePomodoroCompletion,
    getTodayPomodoroCount,
    getPomodoroStatsByDate,
    getWeeklyPomodoroStats
};

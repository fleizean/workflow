// database/db.js
// SQLite database management for Workflow Timer

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

// Database path in user data directory
const dbPath = path.join(app.getPath('userData'), 'krono.db');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

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
    const tableInfo = db.prepare("PRAGMA table_info(work_sessions)").all();
    const hasCompanyId = tableInfo.some(col => col.name === 'company_id');
    const hasNote = tableInfo.some(col => col.name === 'note');

    if (!hasCompanyId) {
        db.exec('ALTER TABLE work_sessions ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE');
    }

    if (!hasNote) {
        db.exec('ALTER TABLE work_sessions ADD COLUMN note TEXT');
    }

    // Create default "Unassigned" company if it doesn't exist
    const defaultCompany = db.prepare("SELECT id FROM companies WHERE name = 'Unassigned'").get();
    if (!defaultCompany) {
        db.prepare("INSERT INTO companies (name) VALUES ('Unassigned')").run();
    }

    // Assign existing work sessions without company_id to the default company
    const unassignedCompanyId = db.prepare("SELECT id FROM companies WHERE name = 'Unassigned'").get()?.id;
    if (unassignedCompanyId) {
        db.prepare("UPDATE work_sessions SET company_id = ? WHERE company_id IS NULL").run(unassignedCompanyId);
    }

    // Settings table
    db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

    // Initialize default settings
    const defaultSettings = {
        daily_target: '28800', // 8 hours in seconds
        goal_notification: 'true',
        start_reminder: 'false',
        haptic_feedback: 'true'
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
function createCompany(name) {
    const stmt = db.prepare('INSERT INTO companies (name) VALUES (?)');
    const result = stmt.run(name);
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
function updateCompany(id, name) {
    const stmt = db.prepare('UPDATE companies SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(name, id);
    return result.changes > 0;
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

    const startDate = monday.toISOString().split('T')[0];
    const endDate = sunday.toISOString().split('T')[0];

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

    const startDate = lastMonday.toISOString().split('T')[0];
    const endDate = lastSunday.toISOString().split('T')[0];

    const stmt = db.prepare('SELECT SUM(duration) as total FROM work_sessions WHERE date BETWEEN ? AND ?');
    const result = stmt.get(startDate, endDate);
    return result.total || 0;
}

/**
 * Calculate current streak (consecutive days of reaching daily target)
 */
function calculateCurrentStreak() {
    const dailyTarget = parseInt(getSetting('daily_target') || '28800');

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
    const todayStr = today.toISOString().split('T')[0];
    const todayData = dailyTotals.find(d => d.date === todayStr);
    const todayReachedTarget = todayData && todayData.total_duration >= dailyTarget;

    // Start from today if target reached, otherwise from yesterday
    let checkDate = new Date(today);
    if (!todayReachedTarget) {
        checkDate.setDate(checkDate.getDate() - 1);
    }

    // Count backwards to find consecutive days with target reached
    while (true) {
        const dateStr = checkDate.toISOString().split('T')[0];
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
    deleteCompany,
    getSessionsGroupedByDateAndCompany,
    getSessionsByDateAndCompany
};

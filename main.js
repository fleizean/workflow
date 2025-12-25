// main.js
// Electron main process

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const db = require('./database/db');
const { exec } = require('child_process');
const os = require('os');

let mainWindow;

/**
 * Create the main application window
 */
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 430,
        height: 932,
        resizable: false,
        frame: false, // Frameless window for modern look
        autoHideMenuBar: true,
        backgroundColor: '#101c22',
        title: 'Workflow Timer',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https:') || url.startsWith('http:')) {

            // WSL kontrolü: Linux ise ve kernel isminde 'microsoft' geçiyorsa
            if (process.platform === 'linux' && os.release().toLowerCase().includes('microsoft')) {
                // Windows komut satırı üzerinden URL'i aç
                exec(`cmd.exe /c start "" "${url}"`, (error) => {
                    if (error) {
                        console.error('Link açılamadı:', error);
                    }
                });
            } else {
                // Normal Windows veya Mac/Linux davranışı
                shell.openExternal(url);
            }
        }
        return { action: 'deny' };
    });

    // Load index.html from new location
    mainWindow.loadFile('src/pages/index.html');

    // Open DevTools in development (disabled for production)
    // mainWindow.webContents.openDevTools();
}

/**
 * Initialize database and create window when app is ready
 */
app.whenReady().then(() => {
    db.initDatabase();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

/**
 * Quit when all windows are closed (except on macOS)
 */
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ============================================
// IPC Handlers for Database Operations
// ============================================

/**
 * Save a work session
 */
ipcMain.handle('save-session', async (event, { name, duration, date, companyId, note }) => {
    try {
        const id = db.saveSession(name, duration, date, companyId, note);
        return { success: true, id };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get all sessions
 */
ipcMain.handle('get-sessions', async () => {
    try {
        const sessions = db.getSessions();
        return { success: true, sessions };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get sessions by date range
 */
ipcMain.handle('get-sessions-by-date', async (event, { startDate, endDate }) => {
    try {
        const sessions = db.getSessionsByDateRange(startDate, endDate);
        return { success: true, sessions };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Update a session
 */
ipcMain.handle('update-session', async (event, { id, name, duration, date, companyId, note }) => {
    try {
        const success = db.updateSession(id, name, duration, date, companyId, note);
        return { success };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Delete a session
 */
ipcMain.handle('delete-session', async (event, { id }) => {
    try {
        const success = db.deleteSession(id);
        return { success };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Delete all sessions
 */
ipcMain.handle('delete-all-sessions', async () => {
    try {
        const count = db.deleteAllSessions();
        return { success: true, count };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Create a company
 */
ipcMain.handle('create-company', async (event, { name }) => {
    try {
        const id = db.createCompany(name);
        return { success: true, id };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get all companies
 */
ipcMain.handle('get-companies', async () => {
    try {
        const companies = db.getCompanies();
        return { success: true, companies };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get a single company
 */
ipcMain.handle('get-company', async (event, { id }) => {
    try {
        const company = db.getCompany(id);
        return { success: true, company };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Update a company
 */
ipcMain.handle('update-company', async (event, { id, name }) => {
    try {
        const success = db.updateCompany(id, name);
        return { success };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Delete a company
 */
ipcMain.handle('delete-company', async (event, { id }) => {
    try {
        const success = db.deleteCompany(id);
        return { success };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get sessions grouped by date and company
 */
ipcMain.handle('get-sessions-grouped', async () => {
    try {
        const groups = db.getSessionsGroupedByDateAndCompany();
        return { success: true, groups };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get detailed sessions for a specific date and company
 */
ipcMain.handle('get-sessions-by-date-company', async (event, { date, companyId }) => {
    try {
        const sessions = db.getSessionsByDateAndCompany(date, companyId);
        return { success: true, sessions };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get a setting
 */
ipcMain.handle('get-setting', async (event, { key }) => {
    try {
        const value = db.getSetting(key);
        return { success: true, value };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Set a setting
 */
ipcMain.handle('set-setting', async (event, { key, value }) => {
    try {
        db.setSetting(key, value);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get this week's total
 */
ipcMain.handle('get-week-total', async () => {
    try {
        const thisWeek = db.getThisWeekTotal();
        const lastWeek = db.getLastWeekTotal();
        return { success: true, thisWeek, lastWeek };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get current streak
 */
ipcMain.handle('get-current-streak', async () => {
    try {
        const streak = db.calculateCurrentStreak();
        return { success: true, streak };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Navigate to a different page
 */
ipcMain.handle('navigate', async (event, { page }) => {
    try {
        // Add src/pages/ prefix if not already present
        const pagePath = page.startsWith('src/') ? page : `src/pages/${page}`;
        mainWindow.loadFile(pagePath);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Window control handlers
 */
ipcMain.on('minimize-window', () => {
    if (mainWindow) {
        mainWindow.minimize();
    }
});

ipcMain.on('close-window', () => {
    if (mainWindow) {
        mainWindow.close();
    }
});

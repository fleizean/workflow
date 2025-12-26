// main.js
// Electron main process

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const db = require('./database/db');
const { exec } = require('child_process');
const os = require('os');

// Helper function to get local date in YYYY-MM-DD format
function getLocalDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

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
        title: 'Workflow',
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
ipcMain.handle('update-company', async (event, { id, name, excelColumn, noteColumn }) => {
    try {
        const success = db.updateCompany(id, name, excelColumn, noteColumn);
        return { success };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Update company Excel configuration
 */
ipcMain.handle('update-company-excel-config', async (event, { id, excelColumn, noteColumn }) => {
    try {
        const success = db.updateCompanyExcelConfig(id, excelColumn, noteColumn);
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
 * Get today's sessions
 */
ipcMain.handle('get-today-sessions', async () => {
    try {
        const sessions = db.getTodaySessions();
        return { success: true, sessions };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Get today's sessions summary for export
 */
ipcMain.handle('get-todays-sessions-summary', async () => {
    try {
        const summary = db.getTodaysSessionsSummary();
        return { success: true, summary };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Export day end - sends data to Google Sheets via Apps Script
 */
/**
 * Helper: Prepare export data
 */
function prepareExportData() {
    const summary = db.getTodaysSessionsSummary();

    // Format duration as decimal hours
    const formatDecimalHours = (seconds) => {
        if (!seconds) return 0;
        const hours = seconds / 3600;
        return Math.round(hours * 100) / 100;
    };

    // Format duration for display
    const formatDuration = (seconds) => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}:${minutes.toString().padStart(2, '0')}`;
    };

    // Prepare export data
    return summary.map(item => ({
        companyName: item.company_name,
        excelColumn: item.excel_column,
        noteColumn: item.note_column,
        duration: formatDuration(item.total_duration || 0),
        durationHours: formatDecimalHours(item.total_duration || 0),
        durationSeconds: item.total_duration || 0,
        notes: item.combined_notes || ''
    }));
}

/**
 * Preview day end data
 */
ipcMain.handle('preview-day-end', async () => {
    try {
        const exportData = prepareExportData();
        return {
            success: true,
            exportData,
            date: getLocalDate()
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

/**
 * Export day end - sends data to Google Sheets via Apps Script
 */
ipcMain.handle('export-day-end', async () => {
    try {
        const exportData = prepareExportData();

        // Get script URL from settings
        const scriptUrl = db.getSetting('script_url');

        // Prepare entries for Google Sheets
        const entries = [];
        exportData.forEach(item => {
            // Add hours entry
            if (item.excelColumn) {
                entries.push({
                    column: item.excelColumn.toUpperCase().replace(/[0-9]/g, ''), // Remove any numbers, keep only letters
                    value: item.durationHours,
                    type: 'hours',
                    company: item.companyName
                });
            }
            // Add notes entry
            if (item.noteColumn) {
                entries.push({
                    column: item.noteColumn.toUpperCase().replace(/[0-9]/g, ''), // Remove any numbers
                    value: item.notes,
                    type: 'note',
                    company: item.companyName
                });
            }
        });

        console.log('=== DAY END EXPORT ===');
        console.log('Date:', getLocalDate());
        const now = new Date();
        console.log('Row:', now.getDate() + 1);
        exportData.forEach(item => {
            console.log(`Company: ${item.companyName}`);
            console.log(`  Duration: ${item.duration} (${item.durationHours}h) -> Column: ${item.excelColumn || 'Not set'}`);
            console.log(`  Note: ${item.notes} -> Column: ${item.noteColumn || 'Not set'}`);
        });
        console.log('======================');

        // If script URL is configured, send data to Google Sheets
        console.log('Script URL:', scriptUrl);
        console.log('Entries:', entries);
        if (scriptUrl && entries.length > 0) {
            const https = require('https');
            const url = require('url');

            // Calculate row based on local date (Day of month + 1)
            const row = now.getDate() + 1;
            const postData = JSON.stringify({ entries, row });
            console.log('Sending to Google Sheets:', postData);
            console.log('Script URL:', scriptUrl);

            const makeRequest = (requestUrl, redirectCount = 0) => {
                return new Promise((resolve, reject) => {
                    if (redirectCount > 5) {
                        reject(new Error('Too many redirects'));
                        return;
                    }

                    const parsedUrl = new URL(requestUrl);

                    const options = {
                        hostname: parsedUrl.hostname,
                        port: 443,
                        path: parsedUrl.pathname + parsedUrl.search,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(postData)
                        }
                    };

                    const req = https.request(options, (res) => {
                        let data = '';

                        // Handle redirects
                        if (res.statusCode === 302 || res.statusCode === 301) {
                            const redirectUrl = res.headers.location;
                            console.log('Redirect to:', redirectUrl);

                            // For GET redirects after POST
                            const getRequest = (getUrl) => {
                                return new Promise((getResolve, getReject) => {
                                    https.get(getUrl, (getRes) => {
                                        let getData = '';
                                        getRes.on('data', chunk => getData += chunk);
                                        getRes.on('end', () => {
                                            try {
                                                getResolve(JSON.parse(getData));
                                            } catch (e) {
                                                // If not JSON, still consider it success
                                                getResolve({ success: true, message: 'Request completed' });
                                            }
                                        });
                                    }).on('error', getReject);
                                });
                            };

                            getRequest(redirectUrl)
                                .then(resolve)
                                .catch(reject);
                            return;
                        }

                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            console.log('Response status:', res.statusCode);
                            console.log('Response data:', data);
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                resolve({ success: true, message: 'Request completed', raw: data });
                            }
                        });
                    });

                    req.on('error', (error) => {
                        console.error('Request error:', error);
                        reject(error);
                    });

                    req.write(postData);
                    req.end();
                });
            };

            try {
                const result = await makeRequest(scriptUrl);
                console.log('Google Sheets result:', result);
                return {
                    success: true,
                    exportData,
                    date: getLocalDate(),
                    googleSheets: result
                };
            } catch (error) {
                console.error('Google Sheets error:', error);
                return {
                    success: true,
                    exportData,
                    date: getLocalDate(),
                    googleSheets: { success: false, error: error.message }
                };
            }
        }

        return {
            success: true,
            exportData,
            date: getLocalDate(),
            googleSheets: scriptUrl ? null : { success: false, error: 'Script URL not configured' }
        };
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

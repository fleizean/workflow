// preload.js
// Secure bridge between renderer and main process

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose protected methods that allow the renderer process
 * to use ipcRenderer without exposing the entire object
 */
contextBridge.exposeInMainWorld('api', {
    // Session operations
    saveSession: (data) => ipcRenderer.invoke('save-session', data),
    getSessions: () => ipcRenderer.invoke('get-sessions'),
    getSessionsByDate: (data) => ipcRenderer.invoke('get-sessions-by-date', data),
    updateSession: (data) => ipcRenderer.invoke('update-session', data),
    deleteSession: (data) => ipcRenderer.invoke('delete-session', data),
    deleteAllSessions: () => ipcRenderer.invoke('delete-all-sessions'),

    // Company operations
    createCompany: (data) => ipcRenderer.invoke('create-company', data),
    getCompanies: () => ipcRenderer.invoke('get-companies'),
    getCompany: (data) => ipcRenderer.invoke('get-company', data),
    updateCompany: (data) => ipcRenderer.invoke('update-company', data),
    deleteCompany: (data) => ipcRenderer.invoke('delete-company', data),
    getSessionsGrouped: () => ipcRenderer.invoke('get-sessions-grouped'),
    getSessionsByDateCompany: (data) => ipcRenderer.invoke('get-sessions-by-date-company', data),

    // Settings operations
    getSetting: (data) => ipcRenderer.invoke('get-setting', data),
    setSetting: (data) => ipcRenderer.invoke('set-setting', data),

    // Stats operations
    getWeekTotal: () => ipcRenderer.invoke('get-week-total'),
    getCurrentStreak: () => ipcRenderer.invoke('get-current-streak'),

    // Navigation
    navigateTo: (data) => ipcRenderer.invoke('navigate', data),

    // Window controls
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    closeWindow: () => ipcRenderer.send('close-window')
});

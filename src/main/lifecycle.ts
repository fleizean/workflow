// App lifecycle handlers, the first interactive window, and the launch that opens the database before it.
// The database layer arrives as launchApplication's argument, so loading this module never loads it.

import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import { PRODUCTION_DATA_DOOR_OPEN, mainConfig } from './config';
import { startDatabase } from './database-startup';
import type { DatabaseLayer } from './database-startup';
import { readLegacyStorage } from './legacy-storage';
import { createMainWindow, hardenWebContents, showRenderer } from './window';

export function registerLifecycle(): void {
    // WR-01: registered before any window exists, so every web contents gets the guard.
    app.on('web-contents-created', (_event, contents) => {
        hardenWebContents(contents);
    });

    // WR-07: a second launch quits at the lock, so this instance surfaces its window instead.
    app.on('second-instance', () => {
        if (mainConfig.smoke) {
            return; // the smoke window stays hidden
        }
        const [win] = BrowserWindow.getAllWindows();
        if (win === undefined) {
            showRenderer(createMainWindow({ show: true }));
            return;
        }
        if (win.isMinimized()) {
            win.restore();
        }
        win.show();
        win.focus();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
}

// D-30: the database is probed, refused or migrated before the first window; a refusal exits here, not deeper.
export async function launchApplication(database: DatabaseLayer): Promise<void> {
    const appData = app.getPath('appData');
    await startDatabase(
        database,
        {
            userDataDir: app.getPath('userData'),
            productionDir: join(appData, app.getName()),
            isPackaged: app.isPackaged,
            smoke: mainConfig.smoke,
            doorOpen: PRODUCTION_DATA_DOOR_OPEN,
            now: new Date()
        },
        {
            report: (_kind, title, body) => { dialog.showErrorBox(title, body); },
            exit: (code) => { app.exit(code); },
            log: (line) => { console.log(line); },
            readLegacyStorage: () => readLegacyStorage(),
            openMainWindow
        }
    );
}

// Non-smoke launches only: a smoke launch never registers 'activate'.
export function openMainWindow(): void {
    showRenderer(createMainWindow({ show: true }));

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            showRenderer(createMainWindow({ show: true }));
        }
    });
}

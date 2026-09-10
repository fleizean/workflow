// App lifecycle handlers and the first interactive window. Registered only once the single-instance lock is held.

import { app, BrowserWindow } from 'electron';
import { mainConfig } from './config';
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

// Non-smoke launches only: a smoke launch never registers 'activate'.
export function openMainWindow(): void {
    showRenderer(createMainWindow({ show: true }));

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            showRenderer(createMainWindow({ show: true }));
        }
    });
}

// App lifecycle handlers, the first interactive window, and the launch that opens the database before it.
// The database layer arrives as launchApplication's argument, so loading this module never loads it.

import { app, dialog } from 'electron';
import { join } from 'node:path';
import { PRODUCTION_DATA_DOOR_OPEN, mainConfig } from './config';
import { clearActiveContainer, createContainer, setActiveContainer } from './container';
import { startDatabase } from './database-startup';
import type { DatabaseLayer } from './database-startup';
import { describeError } from './errors';
import { readLegacyStorage } from './legacy-storage';
import { createMainWindow, hardenWebContents, hasCreatedMainWindow, mainWindows, showRenderer } from './window';

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
        const [win] = mainWindows();
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

    // WR-07: registered here, once by construction. It used to live inside openMainWindow, where a second call
    // would double the handler and one dock click would open two main windows. hasCreatedMainWindow keeps this a
    // re-open only: before the first window, D-30's startup sequence owns when a window may exist.
    app.on('activate', () => {
        if (!mainConfig.smoke && hasCreatedMainWindow() && mainWindows().length === 0) {
            showRenderer(createMainWindow({ show: true }));
        }
    });

    app.on('window-all-closed', () => {
        if (shouldQuitOnAllClosed(hasCreatedMainWindow(), process.platform)) {
            app.quit();
        }
    });

    // D-32: app.exit skips this, so every exit path inside startDatabase closes the database for itself.
    app.on('will-quit', () => {
        closeDatabaseNow();
    });
}

let databaseCloser: (() => void) | undefined;

/** The handle startDatabase opened arrives by injection, so this module still loads no database code. */
export function registerDatabaseCloser(close: () => void): void {
    databaseCloser = close;
}

/** Checkpoints and closes the database once; a no-op before any open and on every later call (D-32). */
export function closeDatabaseNow(): void {
    const close = databaseCloser;
    databaseCloser = undefined;
    // Before the close, so nothing can be handed a repository over a connection on its way out.
    clearActiveContainer();
    if (close === undefined) {
        return;
    }
    // CR-01: will-quit must finish even when the close cannot; the process ending releases the file anyway.
    try {
        close();
    } catch (error) {
        console.error('src/main/lifecycle.ts: the database did not close at quit - ' + describeError(error));
    }
}

/** Pitfall 4: the hidden extractor window must not quit the app before a main window has ever existed. */
export function shouldQuitOnAllClosed(mainWindowCreated: boolean, platform: string): boolean {
    return mainWindowCreated && platform !== 'darwin';
}

// D-30: the database is probed, refused or migrated before the first window; a refusal exits here, not deeper.
export async function launchApplication(database: DatabaseLayer): Promise<void> {
    const appData = app.getPath('appData');
    const started = await startDatabase(
        database,
        {
            userDataDir: app.getPath('userData'),
            productionDir: join(appData, app.getName()),
            isPackaged: app.isPackaged,
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

    if (started !== null) {
        registerDatabaseCloser(started.close);
        // After startDatabase, which owns the door, the classification and the migration; the container only wires
        // what that left open. The main window already exists, so the bus has somewhere to deliver to.
        setActiveContainer(createContainer({
            layer: database,
            connection: started.db,
            log: (line) => { console.log(line); }
        }));
    }
}

export function openMainWindow(): void {
    showRenderer(createMainWindow({ show: true }));
}

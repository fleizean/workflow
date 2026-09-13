// App lifecycle handlers, the first interactive window, and the launch that opens the database before it.
// The database layer arrives as launchApplication's argument, so loading this module never loads it.

import { app, dialog, powerMonitor } from 'electron';
import { join } from 'node:path';
import { PRODUCTION_DATA_DOOR_OPEN, mainConfig } from './config';
import { activeContainer, clearActiveContainer, createContainer, disposeActiveContainer, setActiveContainer } from './container';
import { startDatabase } from './database-startup';
import type { DatabaseLayer, StartedDatabase } from './database-startup';
import { describeError } from './errors';
import { registerIpcHandlers } from './ipc';
import type { HandlerContext } from './ipc';
import { readLegacyStorage } from './legacy-storage';
import { markQuitting } from './quit';
import { createAppTray, destroyAppTray } from './tray';
import type { TimerService } from './services/timer.service';
import {
    createMainWindow, hardenWebContents, hasCreatedMainWindow, mainWindows, registerHideNoticeStore,
    registerWindowBoundsStore, shellControls, showRenderer
} from './window';
import type { HideNoticeStore, WindowBoundsStore } from './window';

export function registerLifecycle(): void {
    // WR-01: registered before any window exists, so every web contents gets the guard.
    app.on('web-contents-created', (_event, contents) => {
        hardenWebContents(contents);
    });

    // WR-07: a second launch quits at the lock, so this instance surfaces its window instead - the same window,
    // over the same database, under the same tray icon.
    app.on('second-instance', () => {
        if (mainConfig.smoke) {
            return; // the smoke window stays hidden
        }
        surfaceMainWindow();
    });

    // WR-07: registered here, once by construction. It used to live inside openMainWindow, where a second call
    // would double the handler and one dock click would open two main windows. hasCreatedMainWindow keeps this a
    // re-open only: before the first window, D-30's startup sequence owns when a window may exist.
    app.on('activate', () => {
        if (!mainConfig.smoke && hasCreatedMainWindow() && mainWindows().length === 0) {
            showRenderer(createMainWindow({ show: true }));
        }
    });

    // Criterion 8: whatever started the quit - the tray menu, a system shutdown - the close handler must stop
    // hiding the window and let it go. Registered here so it is set before any window can receive a close.
    app.on('before-quit', () => {
        markQuitting();
    });

    app.on('window-all-closed', () => {
        if (shouldQuitOnAllClosed(hasCreatedMainWindow(), process.platform)) {
            app.quit();
        }
    });

    // D-32: app.exit skips this, so every exit path inside startDatabase closes the database for itself.
    app.on('will-quit', () => {
        closeDatabaseNow();
        // Windows leaves the icon in the notification area until something moves over it otherwise.
        destroyAppTray();
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
    // The timer flushes first: a write after the close would lose the last seconds counted to a driver error.
    const flushFailure = disposeActiveContainer();
    if (flushFailure !== null) {
        console.error('src/main/lifecycle.ts: the elapsed time did not flush at quit - ' + flushFailure);
    }
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

let powerHandlersRegistered = false;

/**
 * CORE-06: powerMonitor is the precision layer over the clamp, not a substitute for it — it makes a suspended
 * interval exactly zero rather than merely bounded. It is usable only after app.whenReady(), so it is registered
 * with the container rather than in registerLifecycle.
 */
export function registerPowerMonitor(timer: TimerService): void {
    // IN-06: the closure below holds the timer of whichever container registered first, and this flag keeps it
    // there for the life of the process. There is only ever one container; if that changes, suspend and resume
    // would gate a disposed timer while the replacement counted straight through a sleep.
    if (powerHandlersRegistered) {
        return;
    }
    powerHandlersRegistered = true;
    powerMonitor.on('suspend', () => { timer.suspend(); });
    powerMonitor.on('resume', () => { timer.resume(); });
}

/** Pitfall 4: the hidden extractor window must not quit the app before a main window has ever existed. */
export function shouldQuitOnAllClosed(mainWindowCreated: boolean, platform: string): boolean {
    return mainWindowCreated && platform !== 'darwin';
}

/** Brings the one main window back, or opens it again if it has somehow gone. Used by the tray and by a relaunch. */
export function surfaceMainWindow(): void {
    const [win] = mainWindows();
    if (win === undefined) {
        openMainWindow();
        return;
    }
    if (win.isMinimized()) {
        win.restore();
    }
    win.show();
    win.focus();
}

/** IPC-05: the window's own row in app_state. The window module never names the database; this is where it meets it. */
function createWindowBoundsStore(layer: DatabaseLayer, connection: StartedDatabase['db']): WindowBoundsStore {
    return {
        read: () => layer.readWindowBounds(connection),
        write: (bounds) => { layer.writeWindowBounds(connection, bounds, new Date()); }
    };
}

/**
 * The one-time hide notice: read and set in one step, so two hides in flight cannot both be told they are the first.
 * Owner decision 2026-09-13.
 */
export function createHideNoticeStore(layer: DatabaseLayer, connection: StartedDatabase['db']): HideNoticeStore {
    return {
        claim: () => {
            if (layer.readHideNoticeShown(connection)) {
                return false;
            }
            layer.markHideNoticeShown(connection, new Date());
            return true;
        }
    };
}

/** The services the container holds, plus the window the titlebar drives. Resolved per call, never held. */
function handlerContext(): HandlerContext {
    return { ...activeContainer().services, shell: shellControls };
}

// D-30: the database is probed, refused or migrated before the first window; a refusal exits here, not deeper.
export async function launchApplication(database: DatabaseLayer): Promise<void> {
    /*
     * Before the database, deliberately. The window opens inside startDatabase, so a renderer that calls on its first
     * paint must find the channel answered - an unregistered channel rejects the invoke with Electron's own words,
     * while an unbuilt container is an IpcResult the renderer can render. Registration is for the life of the app.
     */
    registerIpcHandlers({ context: handlerContext, log: (line) => { console.log(line); } });

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
            openMainWindow: (connection) => {
                // The store is registered first: the window reads its saved bounds as it is constructed, and a
                // window that opened at the default and then jumped would be worse than one that never moved.
                registerWindowBoundsStore(createWindowBoundsStore(database, connection));
                registerHideNoticeStore(createHideNoticeStore(database, connection));
                openMainWindow();
                createAppTray({
                    show: surfaceMainWindow,
                    isVisible: () => mainWindows()[0]?.isVisible() ?? false,
                    hide: () => { mainWindows()[0]?.hide(); }
                }, (line) => { console.log(line); });
            }
        }
    );

    if (started !== null) {
        registerDatabaseCloser(started.close);
        // After startDatabase, which owns the door, the classification and the migration; the container only wires
        // what that left open. The main window already exists, so the bus has somewhere to deliver to.
        const container = createContainer({
            layer: database,
            connection: started.db,
            log: (line) => { console.log(line); }
        });
        setActiveContainer(container);
        registerPowerMonitor(container.services.timer);
    }
}

export function openMainWindow(): void {
    showRenderer(createMainWindow({ show: true }));
}

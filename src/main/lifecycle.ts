// App lifecycle handlers, the first interactive window, and the launch that opens the database before it.
// The database layer arrives as launchApplication's argument, so loading this module never loads it.

import { app, dialog, powerMonitor, shell } from 'electron';
import { join } from 'node:path';
import {
    DATABASE_RENAME_RELEASED, PRODUCTION_DATA_DOOR_OPEN, UPDATE_CHECK_INTERVAL_MS, UPDATE_FIRST_CHECK_DELAY_MS,
    UPDATE_MANIFEST_URL, UPDATE_MAX_RESPONSE_BYTES, UPDATE_RELEASES_URL, UPDATE_REQUEST_TIMEOUT_MS, mainConfig
} from './config';
import { createHttpsReleases, createNodeScheduler } from './adapters';
import { createUpdateChecker } from './services/update.service';
import type { UpdateChecker } from './services/update.service';
import { activeContainer, clearActiveContainer, createContainer, disposeActiveContainer, setActiveContainer } from './container';
import { startDatabase } from './database-startup';
import type { DatabaseLayer, StartedDatabase } from './database-startup';
import { describeError } from './errors';
import { registerIpcHandlers } from './ipc';
import type { HandlerContext } from './ipc';
import { readLegacyStorage } from './legacy-storage';
import { createFileLog } from './log';
import { clickTray, closePanel } from './panel';
import { markQuitting } from './quit';
import { announceTrayUpdate, createAppTray, destroyAppTray, trayIconBounds } from './tray';
import type { TrayActions } from './tray';
import type { TimerService } from './services/timer.service';
import {
    createMainWindow, hardenWebContents, hasCreatedMainWindow, mainWindows, registerHideNoticeStore,
    registerWindowBoundsStore, registerWindowLog, resetWindowPosition, shellControls, showRenderer
} from './window';
import type { HideNoticeStore, WindowBoundsStore } from './window';
import type { DataDomain, MainWindowIntent } from '@shared/types';

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
        // PANEL-01: the panel must never be a window the quit has to wait for, or get past.
        closePanel();
        // REPO-06, first: cancelling is synchronous and nothing here waits on a request. A check in flight lands on
        // a stopped checker and says nothing, which is what "never delays quit" means in practice.
        stopUpdateChecks();
        closeDatabaseNow();
        // Windows leaves the icon in the notification area until something moves over it otherwise.
        destroyAppTray();
    });
}

/*
 * The one sink the main process reports through. stdout until the launch can name userData, and a bounded file
 * under it from then on: the clamp's own line is the measurement the macOS freeze investigation needed and could
 * not retrieve from a packaged app.
 */
let appLog: (line: string) => void = (line) => { console.log(line); };

export function mainLog(line: string): void {
    appLog(line);
}

let updateChecker: UpdateChecker | undefined;

/**
 * REPO-06: the version check, started once the window exists and the tray is up. Nothing is awaited - the first check
 * is UPDATE_FIRST_CHECK_DELAY_MS away on an unreffed timer, so a launch closed before then sends nothing at all.
 */
export function startUpdateChecks(actions: TrayActions, log: (line: string) => void): void {
    if (!mainConfig.updateCheck || updateChecker !== undefined) {
        return;
    }
    updateChecker = createUpdateChecker({
        releases: createHttpsReleases({
            url: UPDATE_MANIFEST_URL,
            timeoutMs: UPDATE_REQUEST_TIMEOUT_MS,
            maxBytes: UPDATE_MAX_RESPONSE_BYTES,
            log
        }),
        scheduler: createNodeScheduler(),
        installedVersion: app.getVersion(),
        firstDelayMs: UPDATE_FIRST_CHECK_DELAY_MS,
        intervalMs: UPDATE_CHECK_INTERVAL_MS,
        announce: (version) => { announceTrayUpdate(version, actions); },
        log
    });
    updateChecker.start();
}

export function stopUpdateChecks(): void {
    updateChecker?.stop();
    updateChecker = undefined;
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
        mainLog('src/main/lifecycle.ts: the elapsed time did not flush at quit - ' + flushFailure);
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
        mainLog('src/main/lifecycle.ts: the database did not close at quit - ' + describeError(error));
    }
}

let powerHandlersRegistered = false;

/**
 * CORE-06: powerMonitor is the precision layer over the clamp, not a substitute - it makes a suspended interval
 * exactly zero rather than merely bounded. Usable only after app.whenReady(), so it is registered with the container.
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

/** Read and set in one step, so two hides in flight cannot both be told they are the first (owner, 2026-09-13). */
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

/*
 * PANEL-02: the panel's two ways out of itself. The panel goes first - it is about to lose focus to the window
 * being raised, and closing it here rather than leaving it to the blur means nothing is drawn over the form the
 * user is being sent to.
 *
 * The save request is pushed only once the window that has to receive it exists. A window hidden to the tray has a
 * renderer already mounted and gets it immediately; a window that had to be created would miss an event sent before
 * its first load, so that one waits for did-finish-load.
 */
export function showMainWindow(intent: MainWindowIntent): void {
    closePanel();
    const existed = mainWindows().length > 0;
    surfaceMainWindow();
    if (intent !== 'save') {
        return;
    }
    if (existed) {
        announceSaveRequest();
        return;
    }
    mainWindows()[0]?.webContents.once('did-finish-load', () => { announceSaveRequest(); });
}

/** Best effort, like every other bus emit: the window is already up, and a failure here must not undo that. */
function announceSaveRequest(): void {
    try {
        activeContainer().ports.bus.emit('shell:saveRequested', { requestedAt: Date.now() });
    } catch (error) {
        mainLog('src/main/lifecycle.ts: the save request did not reach the window - ' + describeError(error));
    }
}

/** The services the container holds, plus the window the titlebar drives. Resolved per call, never held. */
function handlerContext(): HandlerContext {
    // showMain is composed here rather than put on shellControls: it needs surfaceMainWindow and the panel, and
    // window.ts must not import this module to reach either.
    return { ...activeContainer().services, shell: { ...shellControls, showMain: showMainWindow } };
}

/** SPA-07: main telling the renderer which domains a completed write moved, over the same bus the ticks use. */
function announceChange(domains: readonly DataDomain[]): void {
    activeContainer().ports.bus.emit('data:changed', { domains: [...domains] });
}

// D-30: the database is probed, refused or migrated before the first window; a refusal exits here, not deeper.
export async function launchApplication(database: DatabaseLayer): Promise<void> {
    /*
     * Before the database, deliberately: the window opens inside startDatabase, so a renderer calling on its first
     * paint must find the channel answered. An unregistered channel rejects the invoke with Electron's own words,
     * while an unbuilt container is an IpcResult the renderer can render.
     */
    appLog = createFileLog({ dir: app.getPath('userData'), mirror: (line) => { console.log(line); } });
    registerWindowLog(mainLog);

    registerIpcHandlers({ context: handlerContext, announce: announceChange, log: mainLog });

    const appData = app.getPath('appData');
    const started = await startDatabase(
        database,
        {
            userDataDir: app.getPath('userData'),
            productionDir: join(appData, app.getName()),
            isPackaged: app.isPackaged,
            doorOpen: PRODUCTION_DATA_DOOR_OPEN,
            renameReleased: DATABASE_RENAME_RELEASED,
            now: new Date()
        },
        {
            report: (_kind, title, body) => { dialog.showErrorBox(title, body); },
            exit: (code) => { app.exit(code); },
            log: mainLog,
            readLegacyStorage: () => readLegacyStorage(),
            openMainWindow: (connection) => {
                // The store is registered first: the window reads its saved bounds as it is constructed, and a
                // window that opened at the default and then jumped would be worse than one that never moved.
                registerWindowBoundsStore(createWindowBoundsStore(database, connection));
                registerHideNoticeStore(createHideNoticeStore(database, connection));
                openMainWindow();
                const trayActions: TrayActions = {
                    show: surfaceMainWindow,
                    // PANEL-01: the icon's own rectangle is asked for at the click, not captured now - a display
                    // change or a taskbar the user moved would otherwise anchor the panel to where the icon was.
                    togglePanel: () => {
                        clickTray(() => trayIconBounds(), mainLog);
                    },
                    resetPosition: resetWindowPosition,
                    // WR-01 bans in-app navigation; this hands the address to the OS browser instead, and the
                    // address is a constant, so nothing a response body says can choose where it goes.
                    openReleases: () => { void shell.openExternal(UPDATE_RELEASES_URL); }
                };
                createAppTray(trayActions, app.getVersion(), mainLog);
                startUpdateChecks(trayActions, mainLog);
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
            log: mainLog
        });
        setActiveContainer(container);
        registerPowerMonitor(container.services.timer);
    }
}

export function openMainWindow(): void {
    showRenderer(createMainWindow({ show: true }));
}

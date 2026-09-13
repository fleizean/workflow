// The main window: its factory, the renderer loader and the WR-01 navigation guards.
// The dev-server URL is honoured only unpackaged, so a packaged app never loads an address taken from the environment.

import { app, BrowserWindow, screen, type WebContents } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_WINDOW, WINDOW_BOUNDS_SAVE_DEBOUNCE_MS, mainConfig } from './config';
import { describeError } from './errors';
import { decideWindowClose, isQuitting, markQuitting } from './quit';
import { hasAppTray } from './tray';
import { chooseWindowBounds } from './window-bounds';
import type { WindowBounds } from './window-bounds';

// A failed load is logged, never fatal. ERR_ABORTED (the dev server's first-run reload superseding the load) is not
// even logged; the smoke launch calls loadRenderer directly, where any failed load is a failure.
export function showRenderer(win: BrowserWindow): void {
    loadRenderer(win).catch((error: unknown) => {
        if (isSupersededNavigation(error)) {
            return;
        }
        console.error('src/main/window.ts: renderer failed to load - ' + describeError(error));
    });
}

/** Electron rejects loadURL/loadFile with code ERR_ABORTED when a newer navigation replaces it. */
function isSupersededNavigation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_ABORTED';
}

// Pitfall 4: only windows this factory made count, so the hidden extractor can neither quit the app nor be surfaced.
const created: BrowserWindow[] = [];
let everCreated = false;

/** The main windows still alive, in creation order. */
export function mainWindows(): BrowserWindow[] {
    return created.filter((win) => !win.isDestroyed());
}

/** Whether a main window has ever existed; it stays true once the last one closes. */
export function hasCreatedMainWindow(): boolean {
    return everCreated;
}

/*
 * IPC-05: where the window was last put away, in app_state. Injected rather than imported, so this module still
 * names no database code (D-10) - lifecycle.ts builds the store over the connection startDatabase opened.
 */
export interface WindowBoundsStore {
    read(): WindowBounds | null;
    write(bounds: WindowBounds): void;
}

let boundsStore: WindowBoundsStore | undefined;

export function registerWindowBoundsStore(store: WindowBoundsStore | undefined): void {
    boundsStore = store;
}

/** Owner decision 2026-09-13: the one-time hide notice, in app_state. Injected for the same reason the bounds are. */
export interface HideNoticeStore {
    /** True the first time it is asked and false ever after; it records the answer as it gives it. */
    claim(): boolean;
}

let hideNoticeStore: HideNoticeStore | undefined;

export function registerHideNoticeStore(store: HideNoticeStore | undefined): void {
    hideNoticeStore = store;
}

const MINIMUM = { width: MAIN_WINDOW.minWidth, height: MAIN_WINDOW.minHeight };

/** Criterion 9: restored only onto a display that exists now, which is not the same as the one it was saved on. */
function openingBounds(defaultSize: { width: number; height: number }): ReturnType<typeof chooseWindowBounds> {
    let saved: WindowBounds | null = null;
    try {
        saved = boundsStore?.read() ?? null;
    } catch (error) {
        // A bounds read is never worth failing a launch for; the default position is always available.
        console.error('src/main/window.ts: the saved window bounds could not be read - ' + describeError(error));
    }
    return chooseWindowBounds(saved, screen.getAllDisplays(), defaultSize, MINIMUM);
}

/** A resize fires continuously, so the write lands once the user has stopped, and again when the window goes away. */
function persistBoundsOn(win: BrowserWindow): void {
    let pending: NodeJS.Timeout | undefined;

    const save = (): void => {
        pending = undefined;
        if (win.isDestroyed() || win.isMinimized() || !win.isVisible()) {
            return; // a hidden or minimised window reports bounds nobody chose
        }
        try {
            boundsStore?.write(win.getBounds());
        } catch (error) {
            console.error('src/main/window.ts: the window bounds could not be saved - ' + describeError(error));
        }
    };

    const schedule = (): void => {
        if (pending !== undefined) {
            clearTimeout(pending);
        }
        pending = setTimeout(save, WINDOW_BOUNDS_SAVE_DEBOUNCE_MS);
        pending.unref();
    };

    win.on('resize', schedule);
    win.on('move', schedule);
    win.on('close', () => {
        if (pending !== undefined) {
            clearTimeout(pending);
            pending = undefined;
        }
        save();
    });
}

/** The window main.js creates today, plus the sandbox (T-02-04). */
export function createMainWindow(options: { show: boolean }): BrowserWindow {
    const isMac = process.platform === 'darwin';
    const opening = openingBounds({
        width: MAIN_WINDOW.width,
        height: isMac ? MAIN_WINDOW.macHeight : MAIN_WINDOW.height
    });
    const win = new BrowserWindow({
        width: opening.size.width,
        height: opening.size.height,
        ...(opening.position ?? {}),
        // Criterion 9: Electron refuses a drag below these, so there is no size at which the app cannot be used.
        minWidth: MAIN_WINDOW.minWidth,
        minHeight: MAIN_WINDOW.minHeight,
        resizable: true,
        frame: false,
        autoHideMenuBar: true,
        backgroundColor: MAIN_WINDOW.backgroundColor,
        title: MAIN_WINDOW.title,
        show: options.show,
        webPreferences: {
            // Resolved from this file's own location, never from the working directory (Y8).
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    created.push(win);
    everCreated = true;
    persistBoundsOn(win);

    /*
     * Criterion 8: the close button hides to the tray, as v1.2.1 did - the timer is in main and keeps counting. Once
     * the app is actually quitting the close is allowed through, which is what makes Quit exit rather than re-hide.
     */
    win.on('close', (event) => {
        if (decideWindowClose({ quitting: isQuitting(), hasTray: hasAppTray() }) === 'hide') {
            event.preventDefault();
            win.hide();
        }
    });

    win.on('closed', () => {
        const index = created.indexOf(win);
        if (index >= 0) {
            created.splice(index, 1);
        }
    });
    return win;
}

/*
 * IPC-05: what the titlebar's two buttons do. v1.2.1 sent both of them to one hide (main.js:638-648), so X put the
 * app in the tray rather than ending it; the owner separated them on 2026-09-13 and the channel names now say which
 * is which. Both act on the first main window - there is only ever one.
 */
export const shellControls = {
    /** To the tray while there is one; with none there is nothing to come back from, so the taskbar (WR-03). */
    hide(): void {
        const win = mainWindows()[0];
        if (hasAppTray()) { win?.hide(); } else { win?.minimize(); }
    },

    /*
     * A failure here must not cost the user the hide: the notice is an explanation, and an app that refuses to get
     * out of the way because it could not write a flag is worse than one that explains itself twice.
     */
    claimHideNotice(): { due: boolean } {
        try {
            return { due: hideNoticeStore?.claim() ?? false };
        } catch (error) {
            console.error('src/main/window.ts: the hide notice could not be recorded - ' + describeError(error));
            return { due: false };
        }
    },

    /*
     * Criterion 8 (Phase 5): the flag first, exactly as the tray's own Quit item does it - without it the close
     * handler below hides the window again and the process never ends. app.quit() runs before-quit and will-quit, so
     * the timer flushes what it has counted and the database closes; the seconds come back paused on the next
     * launch (G3/G4). app.exit() would skip all of that.
     */
    quit(): void {
        markQuitting();
        app.quit();
    }
};

/** The dev server when unpackaged, otherwise the built index.html beside __dirname (inside app.asar, never cwd-relative). */
export function loadRenderer(win: BrowserWindow): Promise<void> {
    const devServerUrl = rendererDevServerUrl();
    if (devServerUrl !== undefined) {
        return win.loadURL(devServerUrl);
    }
    return win.loadFile(rendererIndexPath());
}

function rendererDevServerUrl(): string | undefined {
    return !app.isPackaged ? mainConfig.rendererDevUrl : undefined;
}

function rendererIndexPath(): string {
    return join(__dirname, '../renderer/index.html');
}

// WR-01: a navigation leaves the meta CSP behind while the preload bridge stays exposed, so only the
// renderer's own document may load. HashRouter routes are same-document and never raise will-navigate.
export function hardenWebContents(contents: WebContents): void {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => {
        if (!isAppUrl(event.url)) {
            event.preventDefault();
        }
    });
    contents.on('will-redirect', (event) => {
        if (!isAppUrl(event.url)) {
            event.preventDefault();
        }
    });
    contents.on('will-attach-webview', (event) => {
        event.preventDefault();
    });
}

/** The dev server's origin in an unpackaged dev run, otherwise exactly the built index.html. */
function isAppUrl(url: string): boolean {
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return false;
    }
    const devServerUrl = rendererDevServerUrl();
    if (devServerUrl !== undefined) {
        try {
            return target.origin === new URL(devServerUrl).origin;
        } catch {
            return false;
        }
    }
    if (target.protocol !== 'file:') {
        return false;
    }
    let targetPath: string;
    try {
        // Search and hash are not part of the path, so a route or query on the app page still matches.
        targetPath = fileURLToPath(target);
    } catch {
        return false;
    }
    const expected = resolve(rendererIndexPath());
    const actual = resolve(targetPath);
    // NTFS compares paths case-insensitively, and Chromium may spell the drive letter differently.
    return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

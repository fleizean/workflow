// The main window: its factory, the renderer loader and the WR-01 navigation guards.
// The dev-server URL is honoured only unpackaged, so a packaged app never loads an address taken from the environment.

import { app, BrowserWindow, type WebContents } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_WINDOW, mainConfig } from './config';
import { describeError } from './errors';

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

/** The window main.js creates today, plus the sandbox (T-02-04). */
export function createMainWindow(options: { show: boolean }): BrowserWindow {
    const isMac = process.platform === 'darwin';
    const win = new BrowserWindow({
        width: MAIN_WINDOW.width,
        height: isMac ? MAIN_WINDOW.macHeight : MAIN_WINDOW.height,
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
    win.on('closed', () => {
        const index = created.indexOf(win);
        if (index >= 0) {
            created.splice(index, 1);
        }
    });
    return win;
}

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

/*
 * PANEL-01: the frameless panel the tray icon opens. One at a time, anchored to the icon, gone when it loses focus.
 *
 * It is NOT a main window. window.ts's `created` list decides what close-to-tray, the bounds store and
 * window-all-closed are about, and a panel in it would be all three: a panel that hid instead of closing, a panel
 * whose position overwrote the main window's saved rectangle, and a hidden panel keeping the process alive after
 * the last real window went.
 *
 * It is DESTROYED on blur rather than hidden, which is the decision worth defending here. A hidden panel keeps a
 * webContents subscribed to timer:tick for the life of the process - a subscription outliving its surface, which is
 * exactly the defect Phase 7's review found on Home in its other direction. Destroying it ends the document, and
 * the subscription with it, so PANEL-04's "leaks nothing" is a property of the lifetime rather than of a disposer
 * somebody has to remember to call. The cost is a fresh load on every open; the bundle is local and already warm.
 *
 * No tray is created or touched here. createAppTray owns the single icon (criterion 8) and this module never calls it.
 */

import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { PANEL_GAP, PANEL_REOPEN_GUARD_MS, PANEL_ROUTE_HASH, PANEL_WINDOW } from './config';
import { describeError } from './errors';
import { anchorPanel, decidePanelBlur, decidePanelClick } from './panel-anchor';
import type { PanelClick } from './panel-anchor';
import { loadRendererRoute, reviveOnRendererLoss, showRendererRoute } from './window';
import type { WindowBounds } from './window-bounds';

let panel: BrowserWindow | undefined;
/** Whether the panel has been shown yet, so a blur raised before the first show does not close it. */
let panelShown = false;
/** When the panel last closed itself on blur. The tray click arrives after that blur, and is the same click. */
let blurClosedAt: number | undefined;

/** The live panel, for the renderer bus: an event main pushes has to reach the panel as well as the main window. */
export function panelWindows(): BrowserWindow[] {
    return panel !== undefined && !panel.isDestroyed() ? [panel] : [];
}

export function isPanelOpen(): boolean {
    return panelWindows().length > 0;
}

/** Ends the panel now. A no-op when there is none, so every caller may call it unconditionally. */
export function closePanel(): void {
    const open = panel;
    panel = undefined;
    panelShown = false;
    if (open !== undefined && !open.isDestroyed()) {
        open.destroy();
    }
}

/** The screen module's view of the displays, in the Electron-free shape panel-anchor.ts reads. */
function currentDisplays(): WindowBounds[] {
    return screen.getAllDisplays().map((display) => display.workArea);
}

export interface PanelOptions {
    /** The tray icon's rectangle, or null when the platform reports none. */
    readonly tray: WindowBounds | null;
    /** False for the smoke launch, which drives the panel without ever putting it on a screen. */
    readonly show: boolean;
    readonly log: (line: string) => void;
}

/**
 * Opens the panel at the icon, replacing any that is already there. Returns undefined when there is nowhere to put
 * it, which is a screen module reporting no display at all.
 */
export function openPanel(options: PanelOptions): BrowserWindow | undefined {
    closePanel();
    const displays = currentDisplays().map((workArea) => ({ workArea }));
    const anchored = anchorPanel({
        tray: options.tray,
        size: { width: PANEL_WINDOW.width, height: PANEL_WINDOW.height },
        displays,
        gap: PANEL_GAP,
        platform: process.platform
    });
    if (anchored === undefined) {
        options.log('panel: no display was reported, so there is nowhere to open the panel');
        return undefined;
    }

    const win = new BrowserWindow({
        ...anchored.bounds,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        // It is not an application window: it must not appear in the taskbar, the Alt+Tab list or the dock.
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: PANEL_WINDOW.backgroundColor,
        title: PANEL_WINDOW.title,
        show: false,
        webPreferences: {
            // Resolved from this file's own location, never from the working directory (Y8), as window.ts does.
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    panel = win;
    panelShown = false;
    /*
     * PANEL-04 doubles the surface of the renderer-loss defect: the panel draws the same tick stream through the
     * same bus, so a dead panel renderer is a second window showing a number that will never move again.
     */
    reviveOnRendererLoss(win, 'panel', options.log);

    win.on('blur', () => {
        if (decidePanelBlur({ shown: panelShown }) === 'close') {
            blurClosedAt = Date.now();
            closePanel();
        }
    });

    win.on('closed', () => {
        if (panel === win) {
            panel = undefined;
            panelShown = false;
        }
    });

    if (options.show) {
        // Positioned before it is visible, so the panel never appears somewhere and then jumps to the icon.
        win.once('ready-to-show', () => {
            if (win.isDestroyed()) {
                return;
            }
            win.setBounds(anchored.bounds);
            win.show();
            win.focus();
            panelShown = true;
        });
        showRendererRoute(win, PANEL_ROUTE_HASH);
    }
    return win;
}

/** The smoke launch's door: it awaits the load rather than letting a failure go to a log nobody reads. */
export function loadPanel(win: BrowserWindow): Promise<void> {
    return loadRendererRoute(win, PANEL_ROUTE_HASH);
}

/**
 * PANEL-01: what a click on the tray icon does. Toggling, with the guard that stops the blur the click itself
 * caused from turning a close into a reopen.
 */
export function clickTray(tray: () => WindowBounds | null, log: (line: string) => void): PanelClick {
    const since = blurClosedAt === undefined ? null : Date.now() - blurClosedAt;
    const decision = decidePanelClick({ open: isPanelOpen(), sinceBlurCloseMs: since, guardMs: PANEL_REOPEN_GUARD_MS });
    if (decision === 'close') {
        closePanel();
        return decision;
    }
    if (decision === 'open') {
        blurClosedAt = undefined;
        try {
            openPanel({ tray: tray(), show: true, log });
        } catch (error) {
            // A panel that cannot be created must not take the tray, or the app, with it.
            log('panel: the panel could not be opened - ' + describeError(error));
        }
    }
    return decision;
}

/** Test seam: the module-level guard state is process-wide, and a suite needs each case to start from nothing. */
export function resetPanelForTests(): void {
    closePanel();
    blurClosedAt = undefined;
}

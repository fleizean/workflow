// Criterion 8: the tray the app hides to. One icon for the life of the process - a second launch focuses this
// window (lifecycle.ts) rather than reaching here, and a second createAppTray call hands back the first tray.

import { Menu, Tray, app, nativeImage } from 'electron';
import trayIconPath from '../assets/icon.png?asset';
import { TRAY_ICON_SIZE, TRAY_TOOLTIP } from './config';
import { describeError } from './errors';
import { markQuitting } from './quit';
import type { WindowBounds } from './window-bounds';

export interface TrayActions {
    show(): void;
    /**
     * PANEL-01: what a click on the icon does. v1.2.1 toggled the window (main.js:130-139) and so did this tray
     * until Phase 12; the click opens the panel now, and the window is reached from the panel's footer or from the
     * Show item below. The owner asked for the panel on the click, so the toggle is replaced, not doubled up.
     */
    togglePanel(): void;
    /** Phase 10 criterion 5: put a window nobody can reach back in the middle of the primary display. */
    resetPosition(): void;
    /** REPO-06: reached only from an item that exists only when a newer version was actually found. */
    openReleases(): void;
}

/** The label the reset item carries; tools/smoke-packaged.mjs finds the item by it. */
export const RESET_POSITION_LABEL = 'Reset window position';

/** REPO-06: what the installed version reads as. Disabled in the menu - it states a fact, it is not a command. */
export function versionLabel(version: string): string {
    return 'Workflow ' + version;
}

/** REPO-06: shown only when a newer version has actually been published, never as a permanent "check for updates". */
export function updateLabel(version: string): string {
    return 'Update available: ' + version;
}

let tray: Tray | undefined;
let trayMenu: Menu | undefined;
let trayVersion = '';
let trayUpdate: string | undefined;

/*
 * Exported so the packaged smoke can invoke the reset item's own click handler rather than a rebuilt copy, which
 * would prove the template and not the menu. What it still cannot prove is that Windows draws the menu and
 * dispatches the click - the same gap the titlebar's X has, named in the verification report.
 */
export function appTrayMenu(): Menu | undefined {
    return trayMenu;
}

/** The icon, resized: Windows shows a full-size PNG as a smear in the notification area. */
function trayImage(): Electron.NativeImage {
    const image = nativeImage.createFromPath(trayIconPath);
    return image.isEmpty() ? image : image.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
}

/*
 * Built rather than mutated: Electron's MenuItem has no way to add one, and an item always there but disabled would
 * be the "check for updates" affordance REPO-06 deliberately does not offer.
 */
function rebuildMenu(actions: TrayActions): void {
    const update = trayUpdate;
    trayMenu = Menu.buildFromTemplate([
        { label: versionLabel(trayVersion), enabled: false },
        ...(update === undefined ? [] : [{ label: updateLabel(update), click: () => { actions.openReleases(); } }]),
        { type: 'separator' },
        { label: 'Show Workflow', click: () => { actions.show(); } },
        // Above the separator with Show, because both are ways of getting the window back.
        { label: RESET_POSITION_LABEL, click: () => { actions.resetPosition(); } },
        { type: 'separator' },
        {
            label: 'Quit Workflow',
            click: () => {
                markQuitting();
                app.quit();
            }
        }
    ]);
    tray?.setContextMenu(trayMenu);
}

/**
 * REPO-06: idempotent and one-directional - the same version twice redraws nothing, and nothing here takes the notice
 * away, because a check that fails later has not un-published the release.
 */
export function announceTrayUpdate(version: string, actions: TrayActions): void {
    if (tray === undefined || trayUpdate === version) {
        return;
    }
    trayUpdate = version;
    rebuildMenu(actions);
}

/**
 * Quit means quit. v1.2.1's menu set its isQuiting flag before calling app.quit() for the same reason: without it
 * the close handler hides the window again and the process never ends (criterion 8).
 */
export function createAppTray(actions: TrayActions, version: string, log: (line: string) => void): Tray | undefined {
    if (tray !== undefined) {
        return tray;
    }
    trayVersion = version;
    try {
        const image = trayImage();
        if (image.isEmpty()) {
            log('tray: the icon could not be read from ' + trayIconPath + '; the tray icon will be blank');
        }
        tray = new Tray(image);
    } catch (error) {
        // A desktop with no notification area is not a reason to fail startup; the window still works.
        log('tray: no tray could be created - ' + describeError(error));
        return undefined;
    }

    tray.setToolTip(TRAY_TOOLTIP);
    rebuildMenu(actions);

    // PANEL-01: the click opens the panel anchored to this icon. The tray never builds the panel itself - it asks,
    // and src/main/panel.ts owns the window, so nothing here can become a second place windows are made.
    tray.on('click', () => {
        actions.togglePanel();
    });

    return tray;
}

/** Released before the process ends, so the icon does not linger in the notification area on Windows. */
export function destroyAppTray(): void {
    tray?.destroy();
    tray = undefined;
    trayMenu = undefined;
    trayVersion = '';
    trayUpdate = undefined;
}

export function hasAppTray(): boolean {
    return tray !== undefined;
}

/**
 * PANEL-01: the icon's rectangle on screen, which is what the panel anchors to. Electron documents getBounds as
 * macOS and Windows only and Linux answers zeroes; null and a zeroed rectangle mean the same thing to
 * panel-anchor.ts, so neither has to be special-cased by the caller.
 */
export function trayIconBounds(): WindowBounds | null {
    if (tray === undefined) {
        return null;
    }
    try {
        return tray.getBounds();
    } catch (error) {
        // A platform that refuses the question is a platform that reports no icon, not a failed click.
        console.error('src/main/tray.ts: the tray icon bounds could not be read - ' + describeError(error));
        return null;
    }
}

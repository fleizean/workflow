// Criterion 8: the tray the app hides to. One icon for the life of the process - a second launch focuses this
// window (lifecycle.ts) rather than reaching here, and a second createAppTray call hands back the first tray.

import { Menu, Tray, app, nativeImage } from 'electron';
import trayIconPath from '../assets/icon.png?asset';
import { TRAY_ICON_SIZE, TRAY_TOOLTIP } from './config';
import { describeError } from './errors';
import { markQuitting } from './quit';

export interface TrayActions {
    /** Bring the window back from the tray. */
    show(): void;
    /** Whether the window is on screen right now, so a click can toggle it as v1.2.1's did. */
    isVisible(): boolean;
    hide(): void;
    /** Phase 10 criterion 5: put a window nobody can reach back in the middle of the primary display. */
    resetPosition(): void;
    /** REPO-06: opens the releases page in the user's browser. Reached only from an item that exists only when
     * a newer version was actually found. */
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
 * The menu the tray is actually showing.
 *
 * Exported so the packaged smoke can invoke the reset item's own click handler rather than a rebuilt copy of it -
 * which would prove the template and not the menu. What that still cannot prove is that Windows draws the menu and
 * dispatches the click; that is the same gap the titlebar's X has, and it is named in the verification report.
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
 * The menu, built from whatever is known right now. Built rather than mutated: Electron's MenuItem has no way to add
 * one, and an item that is always there and merely disabled would be the "check for updates" affordance REPO-06
 * deliberately does not offer.
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
 * REPO-06: a newer version was found. Idempotent and one-directional - the same version twice redraws nothing, and
 * nothing here can take the notice away, because a check that fails later has not un-published the release.
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

    // v1.2.1 toggled on a click (main.js:130-139), and that is the behaviour being kept.
    tray.on('click', () => {
        if (actions.isVisible()) {
            actions.hide();
        } else {
            actions.show();
        }
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

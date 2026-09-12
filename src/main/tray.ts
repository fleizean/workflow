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
}

let tray: Tray | undefined;

/** The icon, resized: Windows shows a full-size PNG as a smear in the notification area. */
function trayImage(): Electron.NativeImage {
    const image = nativeImage.createFromPath(trayIconPath);
    return image.isEmpty() ? image : image.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
}

/**
 * Quit means quit. v1.2.1's menu set its isQuiting flag before calling app.quit() for the same reason: without it
 * the close handler hides the window again and the process never ends (criterion 8).
 */
export function createAppTray(actions: TrayActions, log: (line: string) => void): Tray | undefined {
    if (tray !== undefined) {
        return tray;
    }
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
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show Workflow', click: () => { actions.show(); } },
        { type: 'separator' },
        {
            label: 'Quit Workflow',
            click: () => {
                markQuitting();
                app.quit();
            }
        }
    ]));

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
}

export function hasAppTray(): boolean {
    return tray !== undefined;
}

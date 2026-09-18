// NotifierPort over Electron's Notification. One of the two files in the app that touch an Electron API outside the
// bootstrap, window, lifecycle and ipc modules (ARCH-01).

import { Notification, nativeImage } from 'electron';
import notificationIconPath from '../../assets/icon-64.png?asset';
import { describeError } from '../errors';
import type { NotifierPort } from '../ports';

/*
 * The logo in the toast: the belt to app-identity.ts's brace, and the only thing that supplies an icon at all on the
 * paths where the identity does not.
 *
 * A 64x64 asset, not src/assets/icon.png - that file is 1024x1024 and 1.84 MB, and decoding a megabyte to draw a 48px
 * square is what Phase 10 criterion 8 is about. icon-64.png is load-bearing: the titlebar and this notifier both read
 * it, so it must not be tidied away with the copies. Exported so tools/smoke-packaged.mjs can check the path the
 * adapter ACTUALLY passes - a ?asset import resolves against the build output, which can differ between dev and packaged.
 */
export const NOTIFICATION_ICON_PATH = notificationIconPath;

/** `log` receives the reasons a best-effort notification did not appear; it is never given the notification text. */
export function createElectronNotifier(log: (line: string) => void): NotifierPort {
    /*
     * Read at most once, and not before the first notification. Decoding at construction time would run inside
     * createElectronPorts, which the unit suite builds in plain Node where nativeImage does not exist. undefined
     * means "not tried yet"; null means "tried and there is nothing usable", which is logged once.
     */
    let icon: Electron.NativeImage | null | undefined;
    const iconOrNull = (): Electron.NativeImage | null => {
        if (icon !== undefined) {
            return icon;
        }
        try {
            const image = nativeImage.createFromPath(NOTIFICATION_ICON_PATH);
            icon = image.isEmpty() ? null : image;
        } catch {
            icon = null;
        }
        if (icon === null) {
            log('notification: the icon could not be read from ' + NOTIFICATION_ICON_PATH +
                '; the toast will carry no logo');
        }
        return icon;
    };

    return {
        notify(request) {
            try {
                if (!Notification.isSupported()) {
                    log('notification: not shown - this platform does not support notifications');
                    return;
                }
                const image = iconOrNull();
                new Notification({
                    title: request.title,
                    body: request.body,
                    // An empty image is worse than none: Windows draws a blank square instead of falling back.
                    ...(image === null ? {} : { icon: image })
                }).show();
            } catch (error) {
                // A notification the OS refuses must not take down the decision that raised it.
                log('notification: not shown - ' + describeError(error));
            }
        }
    };
}

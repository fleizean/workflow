// NotifierPort over Electron's Notification. One of the two files in the app that touch an Electron API outside the
// bootstrap, window, lifecycle and ipc modules (ARCH-01).

import { Notification } from 'electron';
import { describeError } from '../errors';
import type { NotifierPort } from '../ports';

/** `log` receives the reasons a best-effort notification did not appear; it is never given the notification text. */
export function createElectronNotifier(log: (line: string) => void): NotifierPort {
    return {
        notify(request) {
            try {
                if (!Notification.isSupported()) {
                    log('notification: not shown - this platform does not support notifications');
                    return;
                }
                new Notification({ title: request.title, body: request.body }).show();
            } catch (error) {
                // A notification the OS refuses must not take down the decision that raised it.
                log('notification: not shown - ' + describeError(error));
            }
        }
    };
}

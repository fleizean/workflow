/*
 * Who Windows thinks raised a notification.
 *
 * Without an explicit AppUserModelID, Windows cannot associate a toast with an installed application: the header
 * carries Electron's own identity and a default icon rather than this app's name and logo. It has to be set before
 * anything raises a notification or opens a window, and it cannot go above the single-instance lock - only the
 * userData policy may run there (tests/lock-ordering.test.ts) - so src/main/index.ts calls it as the first thing
 * the instance that won the lock does.
 *
 * HONEST LIMITATION, so nobody reports this as working when it is not. The identity resolves through the Start
 * Menu shortcut the NSIS installer writes under the same appId. An unpackaged `npm run dev` run sets the same id
 * with no such shortcut behind it, so the toast there still shows Electron's branding. The installed app is where
 * this takes effect.
 *
 * Electron exposes no getter for the value, so what a packaged run can prove is that this process executed the
 * call and with which argument. appUserModelIdApplied() is that record, and tools/smoke-packaged.mjs reads it.
 */

import { APP_USER_MODEL_ID } from './config';

/** Narrow enough that a test can drive it, and nothing here needs the rest of Electron's app object. */
export interface AppIdentityTarget {
    setAppUserModelId(id: string): void;
}

let applied: string | null = null;

export function applyAppUserModelId(target: AppIdentityTarget, platform: string): string | null {
    if (platform !== 'win32') {
        // macOS and Linux attribute a notification by bundle or desktop entry; there is nothing to set.
        return null;
    }
    target.setAppUserModelId(APP_USER_MODEL_ID);
    applied = APP_USER_MODEL_ID;
    return applied;
}

export function appUserModelIdApplied(): string | null {
    return applied;
}

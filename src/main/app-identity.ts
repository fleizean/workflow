/*
 * Who Windows thinks raised a notification. Without an explicit AppUserModelID the toast header carries Electron's
 * identity and a default icon rather than this app's name and logo. It must be set before anything raises a
 * notification or opens a window, and it cannot go above the single-instance lock - only the userData policy may run
 * there (tests/lock-ordering.test.ts) - so index.ts calls it first in the instance that won the lock.
 *
 * HONEST LIMITATION: the identity resolves through the Start Menu shortcut the NSIS installer writes under the same
 * appId. An unpackaged `npm run dev` sets the same id with no shortcut behind it, so the toast there still shows
 * Electron's branding. Electron exposes no getter, so what a packaged run can prove is that this process made the
 * call and with which argument - appUserModelIdApplied() is that record, and tools/smoke-packaged.mjs reads it.
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

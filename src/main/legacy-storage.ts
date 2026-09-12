// The hidden extractor window (D-33): it reads v1.2.1's two localStorage keys through Chromium and writes none.
// The caller releases the window, because destroying the only window fires window-all-closed (Pitfall 4).

import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { LEGACY_STORAGE_TIMEOUT_MS } from './config';
import { describeError } from './errors';

// Resolved from this file's own location, never from the working directory (Y8).
export const LEGACY_STORAGE_PAGE = join(__dirname, '../renderer/legacy-storage.html');

// The only two scripts the extractor ever runs. getItem alone: a v1.2.1 downgrade must still find its keys (D-34).
const TIMER_STATE_SCRIPT = 'localStorage.getItem("timerState")';
const GOAL_DATE_SCRIPT = 'localStorage.getItem("lastGoalNotificationDate")';

/** The slice of BrowserWindow the extractor uses, so a test can hand in a stand-in instead of mocking electron. */
export interface ExtractorWindow {
    loadFile(path: string): Promise<void>;
    readonly webContents: { executeJavaScript(code: string): Promise<unknown> };
    destroy(): void;
    isDestroyed(): boolean;
}

export type LegacyStorageRead =
    | { readonly ok: true; readonly timerState: string | null; readonly lastGoalNotificationDate: string | null }
    | { readonly ok: false; readonly reason: string };

export interface LegacyStorageSession {
    readonly read: LegacyStorageRead;
    // A closure, not a method: the caller destructures it, and a method signature would carry a `this` to lose.
    readonly release: () => void;
}

export interface LegacyStorageOptions {
    factory?: () => ExtractorWindow;
    timeoutMs?: number;
    pagePath?: string;
}

// Sandboxed, offscreen and with no preload: the page gets no capability beyond reading its own origin's storage.
function createExtractorWindow(): ExtractorWindow {
    return new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true }
    });
}

type NarrowedValue = { ok: true; value: string | null } | { ok: false; reason: string };

// Names the key and the observed type, never the value: a timer string is user state (T-01-37).
function narrowValue(value: unknown, key: string): NarrowedValue {
    if (value === null || typeof value === 'string') {
        return { ok: true, value };
    }
    return {
        ok: false,
        reason: 'localStorage key "' + key + '" read back ' + typeof value + ', expected a string or null'
    };
}

async function readKeys(win: ExtractorWindow, pagePath: string): Promise<LegacyStorageRead> {
    await win.loadFile(pagePath);
    const timerState = narrowValue(await win.webContents.executeJavaScript(TIMER_STATE_SCRIPT), 'timerState');
    if (!timerState.ok) {
        return timerState;
    }
    const goalDate = narrowValue(
        await win.webContents.executeJavaScript(GOAL_DATE_SCRIPT), 'lastGoalNotificationDate'
    );
    if (!goalDate.ok) {
        return goalDate;
    }
    return { ok: true, timerState: timerState.value, lastGoalNotificationDate: goalDate.value };
}

// A hung load or a throwing script becomes { ok: false }, so startup continues and the import retries next launch.
async function readWithTimeout(win: ExtractorWindow, pagePath: string, timeoutMs: number): Promise<LegacyStorageRead> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<LegacyStorageRead>((resolve) => {
        timer = setTimeout(() => {
            resolve({ ok: false, reason: 'timeout after ' + String(timeoutMs) + ' ms' });
        }, timeoutMs);
    });
    try {
        return await Promise.race([readKeys(win, pagePath), expiry]);
    } catch (error) {
        return { ok: false, reason: describeError(error) };
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

/** Never throws, and never destroys the window: the caller releases it once the main window exists (Pitfall 4). */
export async function readLegacyStorage(options: LegacyStorageOptions = {}): Promise<LegacyStorageSession> {
    const timeoutMs = options.timeoutMs ?? LEGACY_STORAGE_TIMEOUT_MS;
    const pagePath = options.pagePath ?? LEGACY_STORAGE_PAGE;

    let win: ExtractorWindow;
    try {
        win = (options.factory ?? createExtractorWindow)();
    } catch (error) {
        return {
            read: { ok: false, reason: 'extractor window: ' + describeError(error) },
            release: (): void => undefined
        };
    }

    const read = await readWithTimeout(win, pagePath, timeoutMs);
    return {
        read,
        release: (): void => {
            if (!win.isDestroyed()) {
                win.destroy();
            }
        }
    };
}

// The --smoke launch for tools/smoke-packaged.mjs (BUILD-06): opens only the injected, new database, then reports.
// The database layer arrives as runSmoke's argument, so loading this module never loads it.

import { app, BrowserWindow } from 'electron';
import { isAbsolute, join } from 'node:path';
import fs from 'node:fs';
import { SHELL_BRIDGE_KEY } from '@shared/constants/bridge';
import type { openDatabase, closeDatabase } from '../lib/db/client';
import {
    RENDERER_MARKER_TEXT, SMOKE_DB_ENV, SMOKE_ESCAPE_URL, SMOKE_EXIT_FALLBACK_MS, SMOKE_NAVIGATION_TIMEOUT_MS,
    SMOKE_POLL_INTERVAL_MS, SMOKE_RENDER_TIMEOUT_MS, mainConfig
} from './config';
import { describeError } from './errors';
import { isSameOrInside } from './userdata-path';
import { createMainWindow, loadRenderer } from './window';

export interface SmokeDatabase {
    readonly openDatabase: typeof openDatabase;
    readonly closeDatabase: typeof closeDatabase;
}

interface SmokeOutcome {
    ok: boolean;
    lines: string[];
}

export async function runSmoke(database: SmokeDatabase): Promise<SmokeOutcome> {
    const appName = app.getName();
    const appData = app.getPath('appData');
    const userData = app.getPath('userData');
    const productionUserData = join(appData, appName);

    // Reported first, so a failure below still tells the harness what the app resolved.
    const lines = [
        'SMOKE_APP_NAME=' + appName,
        'SMOKE_APP_DATA=' + appData,
        'SMOKE_USER_DATA=' + userData
    ];
    const fail = (reason: string): SmokeOutcome => ({ ok: false, lines: [...lines, 'SMOKE_FAIL=' + reason] });

    const dbPath = mainConfig.smokeDbPath;
    if (dbPath === undefined || dbPath.trim() === '') {
        return fail(SMOKE_DB_ENV + ' is not set; smoke mode opens only an injected database path');
    }
    if (!isAbsolute(dbPath)) {
        return fail(SMOKE_DB_ENV + ' must be an absolute path, got ' + dbPath);
    }
    if (isSameOrInside(productionUserData, userData)) {
        return fail('userData resolves inside the production directory ' + productionUserData +
            '; smoke mode requires --user-data-dir pointing somewhere else');
    }
    if (isSameOrInside(productionUserData, dbPath)) {
        return fail(SMOKE_DB_ENV + ' points inside the production directory ' + productionUserData);
    }
    if (fs.existsSync(dbPath)) {
        return fail('refusing to open ' + dbPath + ', which already exists: smoke mode only ever ' +
            'creates a new database, so it can never touch an existing one');
    }
    lines.push('SMOKE_DB=' + dbPath);

    // Injected by src/main/index.ts, which loads the database layer only once the lock is held.
    const { openDatabase, closeDatabase } = database;
    try {
        const db = openDatabase(dbPath);
        try {
            lines.push('SMOKE_JOURNAL_MODE=' + String(db.pragma('journal_mode', { simple: true })));
            const token = 'smoke-' + String(process.pid) + '-' + String(Date.now());
            db.exec('CREATE TABLE smoke (value TEXT NOT NULL)');
            db.prepare('INSERT INTO smoke (value) VALUES (?)').run(token);
            const row = db.prepare<[], { value: string }>('SELECT value FROM smoke').get();
            if (row === undefined || row.value !== token) {
                return fail('read back ' + JSON.stringify(row) + ', expected the row just written');
            }
            lines.push('SMOKE_ROW=' + row.value);
        } finally {
            closeDatabase(db);
        }
    } catch (error) {
        return fail('database: ' + describeError(error));
    }

    // The renderer and preload, through the same resolution the real window uses.
    const win = createMainWindow({ show: false });
    try {
        await loadRenderer(win);
        const rendered = await waitForRendererText(win);
        lines.push('SMOKE_RENDERER_TEXT=' + rendered);
        if (!rendered.includes(RENDERER_MARKER_TEXT)) {
            return fail('the renderer never rendered "' + RENDERER_MARKER_TEXT + '"');
        }
        const bridgeVersion: unknown = await win.webContents.executeJavaScript(
            'typeof window.' + SHELL_BRIDGE_KEY + ' === "object" ? String(window.' +
            SHELL_BRIDGE_KEY + '.version) : ""'
        );
        const version = typeof bridgeVersion === 'string' ? bridgeVersion : '';
        lines.push('SMOKE_PRELOAD_VERSION=' + version);
        if (version === '') {
            return fail('the sandboxed preload did not expose window.' + SHELL_BRIDGE_KEY);
        }

        // WR-01: the guard installed on every web contents, exercised from inside the page.
        const containment = await probeContainment(win);
        lines.push('SMOKE_WINDOW_OPEN_BLOCKED=' + String(containment.windowOpenBlocked));
        lines.push('SMOKE_NAVIGATION_BLOCKED=' + String(containment.navigationBlocked));
        if (!containment.windowOpenBlocked) {
            return fail('window.open from the page was not refused');
        }
        if (!containment.navigationBlocked) {
            return fail('a navigation to ' + SMOKE_ESCAPE_URL + ' was not refused');
        }
    } catch (error) {
        return fail('renderer: ' + describeError(error));
    } finally {
        win.destroy();
    }

    lines.push('SMOKE_OK');
    return { ok: true, lines };
}

/** Polls the page until #root has text containing the marker, or the timeout passes. */
async function waitForRendererText(win: BrowserWindow): Promise<string> {
    const deadline = Date.now() + SMOKE_RENDER_TIMEOUT_MS;
    let text = '';
    while (Date.now() < deadline) {
        const value: unknown = await win.webContents.executeJavaScript(
            'document.getElementById("root") ? document.getElementById("root").textContent : ""'
        );
        text = typeof value === 'string' ? value : '';
        if (text.includes(RENDERER_MARKER_TEXT)) {
            return text;
        }
        await new Promise((done) => setTimeout(done, SMOKE_POLL_INTERVAL_MS));
    }
    return text;
}

// WR-01: both scripts carry a user gesture so only the guard, never a popup blocker, can refuse; the
// navigation is read from the guard's own decision, since a refused one and one in flight look alike.
async function probeContainment(win: BrowserWindow): Promise<{ windowOpenBlocked: boolean; navigationBlocked: boolean }> {
    const windowsBefore = BrowserWindow.getAllWindows().length;
    const openedNothing: unknown = await win.webContents.executeJavaScript(
        'window.open(' + JSON.stringify(SMOKE_ESCAPE_URL) + ') === null', true
    );
    const windowOpenBlocked = openedNothing === true && BrowserWindow.getAllWindows().length === windowsBefore;

    const urlBefore = win.webContents.getURL();
    const decision = new Promise<boolean>((done) => {
        const timer = setTimeout(() => {
            win.webContents.off('will-navigate', observe);
            done(false);
        }, SMOKE_NAVIGATION_TIMEOUT_MS);
        // Registered after the guard (web-contents-created ran when the window was constructed),
        // so the guard has already decided by the time this listener runs.
        function observe(event: Electron.Event<Electron.WebContentsWillNavigateEventParams>): void {
            clearTimeout(timer);
            win.webContents.off('will-navigate', observe);
            done(event.defaultPrevented);
        }
        win.webContents.on('will-navigate', observe);
    });
    // Deferred, so this script returns before the page starts leaving.
    await win.webContents.executeJavaScript(
        'setTimeout(() => { location.href = ' + JSON.stringify(SMOKE_ESCAPE_URL) + '; }, 0); true', true
    );
    const prevented = await decision;
    await new Promise((done) => setTimeout(done, SMOKE_POLL_INTERVAL_MS * 5));
    const stillApp = win.webContents.getURL() === urlBefore &&
        (await waitForRendererText(win)).includes(RENDERER_MARKER_TEXT);
    return { windowOpenBlocked, navigationBlocked: prevented && stillApp };
}

/** Writes the report and exits only once stdout has flushed it; pipes are asynchronous on macOS. */
export function finishSmoke(outcome: SmokeOutcome): void {
    const code = outcome.ok ? 0 : 1;
    const fallback = setTimeout(() => app.exit(code), SMOKE_EXIT_FALLBACK_MS);
    process.stdout.write(outcome.lines.join('\n') + '\n', () => {
        clearTimeout(fallback);
        app.exit(code);
    });
}

/*
 * src/main/index.ts
 *
 * The main-process entry point. electron-vite builds it to out/main/index.js, which package.json
 * names as `main` - the single switch that makes this tree, not the legacy root main.js, the one
 * Electron loads (D-02).
 *
 * THE ORDER OF THE TOP OF THIS FILE IS THE CONTRACT (BUILD-03, D-07). Read it before reordering.
 *
 *   1. electron, node:path, node:fs - none of them touches a database.
 *   2. ./userdata-path, applied immediately. It must run before the single-instance lock, because
 *      Electron keys that lock on the userData directory: a development build has to lock its own
 *      <name>-dev directory, never the production one an installed Workflow may be holding.
 *   3. requestSingleInstanceLock, at top level, before anything else happens.
 *   4. Only once the lock is held, the database layer - by DYNAMIC import, inside a function.
 *
 * Why a dynamic import: a top-level import of a module is evaluated before the first line of this
 * file's own body runs, whatever order the source text suggests. main.js line 6 is the concrete
 * counter-example - it requires database/db.js at the top of the file, that module opens its
 * connection at load, and so the connection exists before app.whenReady and before any lock could
 * have been taken. Two copies of the app launched together both write the same krono.db.
 * The database client module additionally opens nothing at load (BUILD-04), so even an accidental
 * static import would not reopen that hole - but the ordering here must not rely on that. (This
 * header names that module only in words: ordering gates read source text, and a path written
 * here would sit textually ahead of the lock call.)
 *
 * The --smoke branch exists for tools/smoke-packaged.mjs (BUILD-06, D-13): the packaged binary
 * opens a database through the application's own client module, writes and reads a row, loads its
 * own renderer through its own preload, reports what it resolved, and exits. It opens ONLY the
 * path injected through WORKFLOW_SMOKE_DB, refuses a file that already exists, and refuses to run
 * against the production userData directory - so it cannot reach a real user's krono.db even if
 * someone launches it by hand.
 */

import { app, BrowserWindow, type WebContents } from 'electron';
import { isAbsolute, join, relative, resolve } from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHELL_BRIDGE_KEY } from '@shared/constants/bridge';
import {
    MAIN_WINDOW, RENDERER_MARKER_TEXT, SMOKE_DB_ENV, SMOKE_ESCAPE_URL, SMOKE_EXIT_FALLBACK_MS,
    SMOKE_NAVIGATION_TIMEOUT_MS, SMOKE_POLL_INTERVAL_MS, SMOKE_RENDER_TIMEOUT_MS, mainConfig
} from './config';
import { applyUnpackagedUserDataPath } from './userdata-path';

// Step 2: before anything else, a development build gets its own userData directory, or the one an
// explicit --user-data-dir names (WR-06).
if (!app.isPackaged) {
    applyUnpackagedUserDataPath(app);
}

// Step 3: the lock, before any database-touching module has been loaded.
const holdsInstanceLock = app.requestSingleInstanceLock();

if (!holdsInstanceLock) {
    // Another instance owns this userData directory and therefore its database. Leave now.
    app.quit();
} else {
    // WR-01: registered before any window exists, so every web contents gets the guard.
    app.on('web-contents-created', (_event, contents) => {
        hardenWebContents(contents);
    });

    // WR-07: a second launch quits at the lock above, so this instance surfaces its window instead.
    app.on('second-instance', () => {
        if (mainConfig.smoke) {
            return; // the smoke window stays hidden
        }
        const [win] = BrowserWindow.getAllWindows();
        if (win === undefined) {
            showRenderer(createMainWindow({ show: true }));
            return;
        }
        if (win.isMinimized()) {
            win.restore();
        }
        win.show();
        win.focus();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    main().catch((error: unknown) => {
        console.error('src/main/index.ts: startup failed - ' + describeError(error));
        app.exit(1);
    });
}

async function main(): Promise<void> {
    await app.whenReady();

    if (mainConfig.smoke) {
        finishSmoke(await runSmoke());
        return;
    }

    showRenderer(createMainWindow({ show: true }));

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            showRenderer(createMainWindow({ show: true }));
        }
    });
}

/*
 * Loads the renderer into an interactive window. A failed load is reported, never fatal: the
 * window stays up, which is more useful to whoever is looking at it than a process that vanished.
 *
 * ERR_ABORTED is not reported at all. It means the navigation was superseded by another one, and
 * the electron-vite dev server does exactly that on a developer's first run, when its dependency
 * optimiser forces a full page reload while the first load is still in flight. Treating it as a
 * startup failure killed the app on that first launch. The --smoke branch does NOT use this: in a
 * packaged smoke launch nothing may reload the page, so there any failed load is a failure.
 */
function showRenderer(win: BrowserWindow): void {
    loadRenderer(win).catch((error: unknown) => {
        if (isSupersededNavigation(error)) {
            return;
        }
        console.error('src/main/index.ts: renderer failed to load - ' + describeError(error));
    });
}

/** Electron rejects loadURL/loadFile with code ERR_ABORTED when a newer navigation replaces it. */
function isSupersededNavigation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_ABORTED';
}

/** The window main.js creates today, plus the sandbox (T-02-04). */
function createMainWindow(options: { show: boolean }): BrowserWindow {
    const isMac = process.platform === 'darwin';
    return new BrowserWindow({
        width: MAIN_WINDOW.width,
        height: isMac ? MAIN_WINDOW.macHeight : MAIN_WINDOW.height,
        resizable: true,
        frame: false,
        autoHideMenuBar: true,
        backgroundColor: MAIN_WINDOW.backgroundColor,
        title: MAIN_WINDOW.title,
        show: options.show,
        webPreferences: {
            // Resolved from this file's own location, never from the working directory (Y8).
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
}

/**
 * Loads the renderer. The dev server URL is honoured only in an unpackaged build: a packaged app
 * that took its page address from an environment variable could be pointed at remote content.
 * The file path resolves from __dirname, which under asar is inside app.asar - never cwd-relative,
 * which is bug Y8 at main.js line 62.
 */
function loadRenderer(win: BrowserWindow): Promise<void> {
    const devServerUrl = rendererDevServerUrl();
    if (devServerUrl !== undefined) {
        return win.loadURL(devServerUrl);
    }
    return win.loadFile(rendererIndexPath());
}

function rendererDevServerUrl(): string | undefined {
    return !app.isPackaged ? mainConfig.rendererDevUrl : undefined;
}

function rendererIndexPath(): string {
    return join(__dirname, '../renderer/index.html');
}

// WR-01: a navigation leaves the meta CSP behind while the preload bridge stays exposed, so only the
// renderer's own document may load. HashRouter routes are same-document and never raise will-navigate.
function hardenWebContents(contents: WebContents): void {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => {
        if (!isAppUrl(event.url)) {
            event.preventDefault();
        }
    });
    contents.on('will-redirect', (event) => {
        if (!isAppUrl(event.url)) {
            event.preventDefault();
        }
    });
    contents.on('will-attach-webview', (event) => {
        event.preventDefault();
    });
}

/** The dev server's origin in an unpackaged dev run, otherwise exactly the built index.html. */
function isAppUrl(url: string): boolean {
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return false;
    }
    const devServerUrl = rendererDevServerUrl();
    if (devServerUrl !== undefined) {
        try {
            return target.origin === new URL(devServerUrl).origin;
        } catch {
            return false;
        }
    }
    if (target.protocol !== 'file:') {
        return false;
    }
    let targetPath: string;
    try {
        // Search and hash are not part of the path, so a route or query on the app page still matches.
        targetPath = fileURLToPath(target);
    } catch {
        return false;
    }
    const expected = resolve(rendererIndexPath());
    const actual = resolve(targetPath);
    // NTFS compares paths case-insensitively, and Chromium may spell the drive letter differently.
    return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

interface SmokeOutcome {
    ok: boolean;
    lines: string[];
}

/** Whether `child` is `parent` or lies inside it. */
function isWithin(parent: string, child: string): boolean {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function runSmoke(): Promise<SmokeOutcome> {
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
    if (isWithin(productionUserData, userData)) {
        return fail('userData resolves inside the production directory ' + productionUserData +
            '; smoke mode requires --user-data-dir pointing somewhere else');
    }
    if (isWithin(productionUserData, dbPath)) {
        return fail(SMOKE_DB_ENV + ' points inside the production directory ' + productionUserData);
    }
    if (fs.existsSync(dbPath)) {
        return fail('refusing to open ' + dbPath + ', which already exists: smoke mode only ever ' +
            'creates a new database, so it can never touch an existing one');
    }
    lines.push('SMOKE_DB=' + dbPath);

    // Step 4 of the contract above: the database layer, only now that the lock is held.
    const { openDatabase, closeDatabase } = await import('../lib/db/client');
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
function finishSmoke(outcome: SmokeOutcome): void {
    const code = outcome.ok ? 0 : 1;
    const fallback = setTimeout(() => app.exit(code), SMOKE_EXIT_FALLBACK_MS);
    process.stdout.write(outcome.lines.join('\n') + '\n', () => {
        clearTimeout(fallback);
        app.exit(code);
    });
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

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

import { app, BrowserWindow } from 'electron';
import { isAbsolute, join, relative, resolve } from 'node:path';
import fs from 'node:fs';
import { applyDevelopmentUserDataPath } from './userdata-path';

const SMOKE_FLAG = '--smoke';
const SMOKE_DB_ENV = 'WORKFLOW_SMOKE_DB';
// Set by `electron-vite dev` to the renderer dev server's address.
const RENDERER_URL_ENV = 'ELECTRON_RENDERER_URL';
// The key src/preload/index.ts exposes its placeholder bridge under.
const SHELL_BRIDGE_KEY = 'workflowShell';
// What src/renderer/src/main.tsx renders; the smoke launch waits for it.
const RENDERER_MARKER_TEXT = 'Workflow';
const SMOKE_RENDER_TIMEOUT_MS = 20_000;
const SMOKE_POLL_INTERVAL_MS = 100;
// If stdout never reports the write as flushed, exit anyway rather than hang.
const SMOKE_EXIT_FALLBACK_MS = 3_000;

// Step 2: development builds get their own userData directory before anything else happens.
if (!app.isPackaged) {
    applyDevelopmentUserDataPath(app);
}

// Step 3: the lock, before any database-touching module has been loaded.
const holdsInstanceLock = app.requestSingleInstanceLock();

if (!holdsInstanceLock) {
    // Another instance owns this userData directory and therefore its database. Leave now.
    app.quit();
} else {
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

    if (process.argv.includes(SMOKE_FLAG)) {
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
        width: 430,
        height: isMac ? 800 : 932,
        resizable: true,
        frame: false,
        autoHideMenuBar: true,
        backgroundColor: '#101c22',
        title: 'Workflow',
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
    const devServerUrl = process.env[RENDERER_URL_ENV];
    if (!app.isPackaged && devServerUrl !== undefined && devServerUrl !== '') {
        return win.loadURL(devServerUrl);
    }
    return win.loadFile(join(__dirname, '../renderer/index.html'));
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

    const dbPath = process.env[SMOKE_DB_ENV];
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

// The --smoke launch for tools/smoke-packaged.mjs: the real D-30 bootstrap, with reports on stdout instead of a
// modal dialog (Pitfall 6) and exits recorded rather than taken (D-37).
// The database layer arrives as runSmoke's argument, so loading this module never loads it.

import { app, BrowserWindow, session } from 'electron';
import { isAbsolute, join } from 'node:path';
import fs from 'node:fs';
import { API_BRIDGE_KEY, SHELL_BRIDGE_KEY } from '@shared/constants/bridge';
import { IPC_CHANNELS } from '@shared/ipc/channels';
import type * as DatabaseLayerModule from '../lib/db';
import {
    PRODUCTION_DATA_DOOR_OPEN, RENDERER_MARKER_TEXT, SMOKE_DB_ENV, SMOKE_ESCAPE_URL, SMOKE_EXIT_FALLBACK_MS,
    SMOKE_NAVIGATION_TIMEOUT_MS, SMOKE_POLL_INTERVAL_MS, SMOKE_RENDER_TIMEOUT_MS, SMOKE_STORAGE_FLUSH_MS,
    SMOKE_TICK_WAIT_MS, mainConfig
} from './config';
import { clearActiveContainer, createContainer, setActiveContainer } from './container';
import type { AppContainer } from './container';
import { registerIpcHandlers, removeIpcHandlers } from './ipc';
import { decideWindowClose, markQuitting } from './quit';
import { createAppTray, destroyAppTray } from './tray';
import { startDatabase } from './database-startup';
import type { LegacyImportStatus, StartedDatabase } from './database-startup';
import { describeError } from './errors';
import { LEGACY_STORAGE_PAGE, readLegacyStorage } from './legacy-storage';
import { isSameOrInside } from './userdata-path';
import { createMainWindow, loadRenderer, windowControls } from './window';

export type SmokeDatabase = typeof DatabaseLayerModule;

interface SmokeOutcome {
    ok: boolean;
    lines: string[];
    /** An exit code startup asked for; absent means the smoke's own 0/1 verdict stands. */
    code?: number;
}

function describeLegacyImport(status: LegacyImportStatus): string {
    return 'failed' in status
        ? 'failed'
        : 'timerState=' + status.timerState + ' goalDate=' + status.goalDate;
}

export async function runSmoke(layer: SmokeDatabase): Promise<SmokeOutcome> {
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

    // D-37: seed this temp profile's localStorage and stop. Only reachable under --smoke, and only after the
    // refusals above have proved userData is not the production directory (T-04-48).
    const seed = mainConfig.smokeSeedTimerState;
    if (seed !== undefined) {
        const seedFailure = await seedLegacyTimerState(seed);
        if (seedFailure !== null) {
            return fail(seedFailure);
        }
        lines.push('SMOKE_SEEDED=timerState', 'SMOKE_OK');
        return { ok: true, lines };
    }

    // D-37: the real bootstrap, over ports that print instead of showing a dialog or exiting.
    let exitCode: number | undefined;
    let win: BrowserWindow | undefined;
    const started = await startDatabase(
        layer,
        {
            userDataDir: userData,
            productionDir: productionUserData,
            isPackaged: app.isPackaged,
            doorOpen: PRODUCTION_DATA_DOOR_OPEN,
            now: new Date()
        },
        {
            report: (kind, title) => {
                lines.push('SMOKE_REPORT_KIND=' + kind, 'SMOKE_REPORT_TITLE=' + title);
            },
            exit: (code) => { exitCode = code; },
            log: (line) => { lines.push('SMOKE_DB_MIGRATION=' + line); },
            readLegacyStorage: () => readLegacyStorage(),
            openMainWindow: () => {
                win = createMainWindow({ show: false });
                lines.push('SMOKE_WINDOW_CREATED=true');
            }
        }
    );
    if (started === null) {
        return { ok: false, lines, code: exitCode ?? 1 };
    }
    lines.push('SMOKE_DB_CLASS=' + started.report.dbClass);
    lines.push('SMOKE_DB_VERSION=' + String(started.report.toVersion));
    lines.push('SMOKE_TIMER_IMPORT=' + describeLegacyImport(started.legacyImport));

    let container: AppContainer | undefined;
    try {
        // BUILD-06: the composition root, the adapters and one Drizzle read, inside the packaged app. Nothing else
        // here exercises the bundled drizzle-orm chunk, so a bundling fault in it would otherwise wait for Phase 7.
        const built = buildContainer(layer, started.db, lines);
        if (typeof built === 'string') {
            return fail(built);
        }
        container = built;
        // IPC-01: the real registration, over the real container, so the page below calls the app rather than a stub.
        setActiveContainer(container);
        registerIpcHandlers({
            context: () => ({ ...built.services, window: windowControls }),
            log: (line) => lines.push('SMOKE_IPC_LOG=' + line)
        });

        // BUILD-06: the injected, brand-new database, through the same driver the bootstrap just used.
        const databaseFailure = checkInjectedDatabase(layer, dbPath, lines);
        if (databaseFailure !== null) {
            return fail(databaseFailure);
        }
        if (win === undefined) {
            return fail('startup returned a database without ever opening a main window');
        }
        const rendererFailure = await checkRenderer(win, lines);
        if (rendererFailure !== null) {
            return fail(rendererFailure);
        }
        const bridgeFailure = await checkBridge(win, container, lines);
        if (bridgeFailure !== null) {
            return fail(bridgeFailure);
        }
        // Last, because it ends by telling the app it is quitting - which is the state being proved.
        const shellFailure = await checkShell(lines);
        if (shellFailure !== null) {
            return fail(shellFailure);
        }
    } finally {
        removeIpcHandlers();
        clearActiveContainer();
        // D-32: before the window goes, so the -wal is folded back in even if a check threw.
        container?.dispose();
        started.close();
        win?.destroy();
    }

    lines.push('SMOKE_OK');
    return { ok: true, lines };
}

// D-37: written through the page the extractor reads, so the seed lands in the same file:// origin. Sandboxed and
// offscreen, like the extractor: the page gets no capability beyond its own origin's storage.
async function seedLegacyTimerState(raw: string): Promise<string | null> {
    const win = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true }
    });
    try {
        await win.loadFile(LEGACY_STORAGE_PAGE);
        await win.webContents.executeJavaScript(
            'localStorage.setItem("timerState", ' + JSON.stringify(raw) + '); true'
        );
        // app.exit skips the usual teardown, so the value has to be on disk before this launch ends (Pitfall 5).
        session.defaultSession.flushStorageData();
        await new Promise((done) => setTimeout(done, SMOKE_STORAGE_FLUSH_MS));
    } catch (error) {
        return 'seed: ' + describeError(error);
    } finally {
        win.destroy();
    }
    return null;
}

/** The built container, or the reason it could not be built. The caller disposes it. */
function buildContainer(
    layer: SmokeDatabase,
    connection: StartedDatabase['db'],
    lines: string[]
): AppContainer | string {
    try {
        const container = createContainer({
            layer,
            connection,
            log: (line) => lines.push('SMOKE_CONTAINER_LOG=' + line)
        });
        lines.push('SMOKE_CONTAINER_PORTS=' + Object.keys(container.ports).sort().join(','));
        lines.push('SMOKE_CONTAINER_SERVICES=' + Object.keys(container.services).sort().join(','));
        lines.push('SMOKE_CONTAINER_COMPANIES=' + String(container.repositories.companies.list().length));
        lines.push('SMOKE_CONTAINER_TARGET=' + String(container.repositories.settings.get().dailyTargetSeconds));
        const timer = container.services.timer.snapshot();
        lines.push('SMOKE_CONTAINER_TIMER=' + [
            timer.status, timer.mode, String(timer.elapsedSeconds), String(timer.restoredFromPreviousLaunch)
        ].join('/'));
        return container;
    } catch (error) {
        return 'container: ' + describeError(error);
    }
}

/*
 * Criteria 6, 7 and 10 inside the packaged app: the page calls through the generated bridge, a malformed payload is
 * refused by main before any service runs, a main-process tick is delivered to a subscription, and the disposer that
 * subscription returned actually stops the next one.
 */
async function checkBridge(win: BrowserWindow, container: AppContainer, lines: string[]): Promise<string | null> {
    try {
        const opened: unknown = await win.webContents.executeJavaScript(SUBSCRIBE_SCRIPT);
        const surface = asRecord(opened);
        lines.push('SMOKE_BRIDGE_CHANNELS=' + text(surface.channels));
        lines.push('SMOKE_BRIDGE_CALL=' + text(surface.call));
        lines.push('SMOKE_BRIDGE_REFUSAL=' + text(surface.refusal));
        lines.push('SMOKE_BRIDGE_DISPOSER=' + text(surface.disposer));

        if (surface.channels !== IPC_CHANNELS.length) {
            return 'the bridge exposed ' + text(surface.channels) + ' channels, expected ' +
                String(IPC_CHANNELS.length);
        }
        if (surface.call !== 'ok') {
            return 'companies:list through the bridge answered ' + text(surface.call);
        }
        if (surface.refusal !== 'INVALID_INPUT') {
            return 'a malformed timer:setMode was answered with ' + text(surface.refusal);
        }
        if (surface.disposer !== 'function') {
            return 'a subscription returned ' + text(surface.disposer) + ' instead of a disposer';
        }

        // One second of the real clock, delivered by the real bus to the real preload subscription.
        container.services.timer.start();
        await new Promise((done) => setTimeout(done, SMOKE_TICK_WAIT_MS));
        container.services.timer.pause();
        const delivered = asRecord(await win.webContents.executeJavaScript(READ_TICKS_SCRIPT));
        lines.push('SMOKE_BRIDGE_TICKS=' + text(delivered.ticks));
        lines.push('SMOKE_BRIDGE_TICK_KEYS=' + text(delivered.keys));
        if (typeof delivered.ticks !== 'number' || delivered.ticks < 1) {
            return 'no timer:tick reached the page in ' + String(SMOKE_TICK_WAIT_MS) + ' ms';
        }
        if (delivered.keys !== 'elapsedSeconds,mode,restoredFromPreviousLaunch,status') {
            return 'a tick arrived shaped as ' + text(delivered.keys);
        }

        // Criterion 10: after the disposer, the next tick must reach nobody.
        await win.webContents.executeJavaScript(DISPOSE_SCRIPT);
        container.services.timer.start();
        await new Promise((done) => setTimeout(done, SMOKE_TICK_WAIT_MS));
        container.services.timer.pause();
        const after = asRecord(await win.webContents.executeJavaScript(READ_TICKS_SCRIPT));
        lines.push('SMOKE_BRIDGE_TICKS_AFTER_DISPOSE=' + text(after.ticks));
        if (after.ticks !== delivered.ticks) {
            return 'a disposed subscription still received ' +
                String(Number(after.ticks) - Number(delivered.ticks)) + ' events';
        }
        container.services.timer.reset();
    } catch (error) {
        return 'bridge: ' + describeError(error);
    }
    return null;
}

/** Resolves when the window has actually gone, or once the wait is over - a window that stayed is the finding. */
const settled = (win: BrowserWindow): Promise<void> =>
    new Promise((done) => {
        const timer = setTimeout(() => done(), SMOKE_POLL_INTERVAL_MS * 5);
        win.once('closed', () => {
            clearTimeout(timer);
            done();
        });
    });

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};

/** A value the page returned, as a line of the report. Nothing from a page is trusted to stringify itself. */
const text = (value: unknown): string =>
    typeof value === 'string' ? value
        : typeof value === 'number' || typeof value === 'boolean' ? String(value)
            : JSON.stringify(value) ?? 'undefined';

// Written as strings because they run in the page, not here. Each returns a plain object, so it crosses as JSON.
const SUBSCRIBE_SCRIPT = `(async () => {
    const api = window.${API_BRIDGE_KEY};
    if (typeof api !== 'object' || api === null) return { channels: -1 };
    const list = await api['companies:list']();
    const refused = await api['timer:setMode']({ mode: 'sideways' });
    window.__smokeBridge = { ticks: [], last: null };
    const dispose = api.on['timer:tick']((payload) => {
        window.__smokeBridge.ticks.push(1);
        window.__smokeBridge.last = payload;
    });
    window.__smokeBridge.dispose = dispose;
    return {
        channels: Object.keys(api).filter((key) => key !== 'on').length,
        call: list && list.ok === true && Array.isArray(list.data) ? 'ok' : JSON.stringify(list),
        refusal: refused && refused.ok === false ? refused.error.code : 'accepted',
        disposer: typeof dispose
    };
})()`;

const READ_TICKS_SCRIPT = `({
    ticks: window.__smokeBridge.ticks.length,
    keys: window.__smokeBridge.last === null ? '' : Object.keys(window.__smokeBridge.last).sort().join(',')
})`;

const DISPOSE_SCRIPT = 'window.__smokeBridge.dispose(); window.__smokeBridge.dispose(); true';

/*
 * Criterion 8 in the packaged app: one tray icon however often it is asked for, a close that hides the window while
 * the app is running, and a close that lets it go once the app is quitting. The quitting flag is set at the very end
 * of the smoke on purpose - nothing runs after it but the report.
 */
async function checkShell(lines: string[]): Promise<string | null> {
    try {
        const actions = { show: () => undefined, hide: () => undefined, isVisible: () => false };
        const log = (line: string): void => { lines.push('SMOKE_TRAY_LOG=' + line); };
        const first = createAppTray(actions, log);
        const second = createAppTray(actions, log);
        lines.push('SMOKE_TRAY_CREATED=' + String(first !== undefined));
        lines.push('SMOKE_TRAY_SINGLETON=' + String(first === second));

        // A window of its own, so the one the renderer checks ran against is left alone.
        const probe = createMainWindow({ show: false });
        lines.push('SMOKE_CLOSE_DECISION=' + decideWindowClose({ quitting: false }));
        probe.close();
        // A close that is allowed through destroys the window on a later turn of the loop, so both readings wait.
        await settled(probe);
        lines.push('SMOKE_WINDOW_AFTER_CLOSE=' + (probe.isDestroyed() ? 'destroyed' : 'alive'));

        markQuitting();
        lines.push('SMOKE_QUIT_DECISION=' + decideWindowClose({ quitting: true }));
        probe.close();
        await settled(probe);
        lines.push('SMOKE_WINDOW_AFTER_QUIT=' + (probe.isDestroyed() ? 'destroyed' : 'alive'));
        destroyAppTray();
    } catch (error) {
        return 'shell: ' + describeError(error);
    }
    return null;
}

/** Returns the failure reason, or null when every check passed. */
function checkInjectedDatabase(layer: SmokeDatabase, dbPath: string, lines: string[]): string | null {
    const { openDatabase, closeDatabase } = layer;
    try {
        const db = openDatabase(dbPath);
        try {
            lines.push('SMOKE_JOURNAL_MODE=' + String(db.pragma('journal_mode', { simple: true })));
            const token = 'smoke-' + String(process.pid) + '-' + String(Date.now());
            db.exec('CREATE TABLE smoke (value TEXT NOT NULL)');
            db.prepare('INSERT INTO smoke (value) VALUES (?)').run(token);
            const row = db.prepare<[], { value: string }>('SELECT value FROM smoke').get();
            if (row === undefined || row.value !== token) {
                return 'read back ' + JSON.stringify(row) + ', expected the row just written';
            }
            lines.push('SMOKE_ROW=' + row.value);
        } finally {
            closeDatabase(db);
        }
    } catch (error) {
        return 'database: ' + describeError(error);
    }
    return null;
}

/** Returns the failure reason, or null when every check passed. The window is the one startup opened. */
async function checkRenderer(win: BrowserWindow, lines: string[]): Promise<string | null> {
    try {
        await loadRenderer(win);
        const rendered = await waitForRendererText(win);
        lines.push('SMOKE_RENDERER_TEXT=' + rendered);
        if (!rendered.includes(RENDERER_MARKER_TEXT)) {
            return 'the renderer never rendered "' + RENDERER_MARKER_TEXT + '"';
        }
        const bridgeVersion: unknown = await win.webContents.executeJavaScript(
            'typeof window.' + SHELL_BRIDGE_KEY + ' === "object" ? String(window.' +
            SHELL_BRIDGE_KEY + '.version) : ""'
        );
        const version = typeof bridgeVersion === 'string' ? bridgeVersion : '';
        lines.push('SMOKE_PRELOAD_VERSION=' + version);
        if (version === '') {
            return 'the sandboxed preload did not expose window.' + SHELL_BRIDGE_KEY;
        }

        // WR-01: the guard installed on every web contents, exercised from inside the page.
        const containment = await probeContainment(win);
        lines.push('SMOKE_WINDOW_OPEN_BLOCKED=' + String(containment.windowOpenBlocked));
        lines.push('SMOKE_NAVIGATION_BLOCKED=' + String(containment.navigationBlocked));
        if (!containment.windowOpenBlocked) {
            return 'window.open from the page was not refused';
        }
        if (!containment.navigationBlocked) {
            return 'a navigation to ' + SMOKE_ESCAPE_URL + ' was not refused';
        }
    } catch (error) {
        return 'renderer: ' + describeError(error);
    }
    return null;
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
    const code = outcome.code ?? (outcome.ok ? 0 : 1);
    const fallback = setTimeout(() => app.exit(code), SMOKE_EXIT_FALLBACK_MS);
    process.stdout.write(outcome.lines.join('\n') + '\n', () => {
        clearTimeout(fallback);
        app.exit(code);
    });
}

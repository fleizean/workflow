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
    DATABASE_RENAME_RELEASED, EXIT_CODES, PRODUCTION_DATA_DOOR_OPEN, RENDERER_COMPANIES_ROUTE_HASH,
    RENDERER_DESTRUCTIVE_TESTID, RENDERER_LEGACY_DESTRUCTIVE_SELECTOR,
    RENDERER_MARKER_TEXT, RENDERER_SECOND_ROUTE_HASH,
    RENDERER_SECOND_ROUTE_TEXT, SMOKE_BUNDLED_FONTS, SMOKE_DB_ENV, SMOKE_ESCAPE_URL, SMOKE_EXIT_FALLBACK_MS,
    SMOKE_ICON_FONT_SIZE_PX, SMOKE_ICON_NAME, SMOKE_NAVIGATION_TIMEOUT_MS, SMOKE_POLL_INTERVAL_MS,
    SMOKE_RENDER_TIMEOUT_MS, SMOKE_SETTINGS_NUMBER_FIELDS, SMOKE_SETTINGS_TARGET_SECONDS,
    SMOKE_SETTINGS_TARGET_TEXT, SMOKE_SOUND_ID, SMOKE_STORAGE_FLUSH_MS, SMOKE_TICK_WAIT_MS, SMOKE_WATCHDOG_MS,
    SMOKE_XSS_COMPANY_NAME, mainConfig
} from './config';
import { clearActiveContainer, createContainer, setActiveContainer } from './container';
import type { AppContainer } from './container';
import { registerIpcHandlers, removeIpcHandlers } from './ipc';
import { decideWindowClose, markQuitting } from './quit';
import { createAppTray, destroyAppTray, hasAppTray } from './tray';
import { startDatabase } from './database-startup';
import type { LegacyImportStatus, StartedDatabase } from './database-startup';
import { describeError } from './errors';
import { createHideNoticeStore } from './lifecycle';
import { LEGACY_STORAGE_PAGE, readLegacyStorage } from './legacy-storage';
import { isSameOrInside } from './userdata-path';
import { createMainWindow, loadRenderer, registerHideNoticeStore, shellControls } from './window';

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

let watchdog: NodeJS.Timeout | undefined;
// The report so far, so a run killed by the watchdog still says how far it got rather than only that it stopped.
let reportedSoFar: readonly string[] = [];

/*
 * A smoke launch has no window on screen and no tray icon, so a run that never finishes is a process only Task
 * Manager can end - and on a developer's machine it is invisible until something else goes wrong. It ends itself
 * instead, and it ends FAILING: a hang is a real failure, and a watchdog that exited 0 would hide one.
 *
 * unref'd, so the watchdog can never itself be the reason the process is still alive; Electron's app keeps the loop
 * running, which is exactly the condition it exists to break.
 */
function armWatchdog(lines: readonly string[]): void {
    reportedSoFar = lines;
    watchdog = setTimeout(() => {
        finishSmoke({
            ok: false,
            code: EXIT_CODES.smokeStuck,
            lines: [...reportedSoFar,
                'SMOKE_FAIL=watchdog: the launch did not finish within ' + String(SMOKE_WATCHDOG_MS) + ' ms']
        });
    }, SMOKE_WATCHDOG_MS);
    watchdog.unref();
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
    armWatchdog(lines);
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

    // SPA-08: networking off before the first document loads, so nothing below could have been fetched remotely.
    const remoteRequests = goOffline(lines);

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
            renameReleased: DATABASE_RENAME_RELEASED,
            now: new Date()
        },
        {
            report: (kind, title) => {
                lines.push('SMOKE_REPORT_KIND=' + kind, 'SMOKE_REPORT_TITLE=' + title);
            },
            exit: (code) => { exitCode = code; },
            log: (line) => { lines.push('SMOKE_DB_MIGRATION=' + line); },
            readLegacyStorage: () => readLegacyStorage(),
            openMainWindow: (connection) => {
                // The same store the app registers, over the injected database, so the claim below is the real one.
                registerHideNoticeStore(createHideNoticeStore(layer, connection));
                win = createMainWindow({ show: false });
                /*
                 * The smoke plays the bundled notification to prove the file is in the bundle and decodes; it has no
                 * reason to be audible to whoever is running it, and every run used to come out of the developer's
                 * speakers. Muted here rather than in the sound path: nothing outside smoke mode reaches this line,
                 * and what checkSound reads - a play, a file: src, a decoded duration, no MediaError - is decode
                 * state, which muting does not touch.
                 */
                win.webContents.setAudioMuted(true);
                lines.push('SMOKE_WINDOW_CREATED=true');
                lines.push('SMOKE_AUDIO_MUTED=' + String(win.webContents.isAudioMuted()));
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
            context: () => ({ ...built.services, shell: shellControls }),
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
        /*
         * Before the first render, because the Settings form seeds its fields once from what the database held
         * when it opened. Restored below, so the launch leaves the injected database as it found it.
         */
        const settingsBefore = container.services.settings.get();
        container.services.settings.update({
            dailyTargetSeconds: SMOKE_SETTINGS_TARGET_SECONDS,
            pomodoroEnabled: true
        });
        const rendererFailure = await checkRenderer(win, lines);
        if (rendererFailure !== null) {
            return fail(rendererFailure);
        }
        const bridgeFailure = await checkBridge(win, container, lines);
        if (bridgeFailure !== null) {
            return fail(bridgeFailure);
        }
        const soundFailure = await checkSound(win, container, lines);
        if (soundFailure !== null) {
            return fail(soundFailure);
        }
        const escapingFailure = await checkEscaping(win, container, lines);
        if (escapingFailure !== null) {
            return fail(escapingFailure);
        }
        const settingsFailure = await checkSettingsScreen(win, lines);
        container.services.settings.update({
            dailyTargetSeconds: settingsBefore.dailyTargetSeconds,
            pomodoroEnabled: settingsBefore.pomodoroEnabled
        });
        if (settingsFailure !== null) {
            return fail(settingsFailure);
        }
        lines.push('SMOKE_OFFLINE_REQUESTS=' + String(remoteRequests()));
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
        if (delivered.keys !== 'elapsedSeconds,mode,persistFailing,restoredFromPreviousLaunch,status') {
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

        const notice = asRecord(await win.webContents.executeJavaScript(CLAIM_HIDE_NOTICE_SCRIPT));
        lines.push('SMOKE_HIDE_NOTICE_FIRST=' + text(notice.first));
        lines.push('SMOKE_HIDE_NOTICE_SECOND=' + text(notice.second));
        if (notice.first !== 'true' || notice.second !== 'false') {
            return 'the hide notice claimed ' + text(notice.first) + ' then ' + text(notice.second) +
                '; it must be due exactly once';
        }
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

/*
 * Owner decision 2026-09-13, end to end: the hide notice is claimed through the bridge, answered by main against the
 * app_state row, and the second ask gets nothing. Two calls in one script, so nothing between them can explain a
 * false second answer.
 */
const CLAIM_HIDE_NOTICE_SCRIPT = `(async () => {
    const api = window.${API_BRIDGE_KEY};
    const first = await api['window:claimHideNotice']();
    const second = await api['window:claimHideNotice']();
    return {
        first: first && first.ok === true ? String(first.data.due) : JSON.stringify(first),
        second: second && second.ok === true ? String(second.data.due) : JSON.stringify(second)
    };
})()`;

const READ_TICKS_SCRIPT = `({
    ticks: window.__smokeBridge.ticks.length,
    keys: window.__smokeBridge.last === null ? '' : Object.keys(window.__smokeBridge.last).sort().join(',')
})`;

const DISPOSE_SCRIPT = 'window.__smokeBridge.dispose(); window.__smokeBridge.dispose(); true';

// SPA-10: which src the renderer actually asked to play, and whether the file behind it decoded.
const WATCH_AUDIO_SCRIPT = `(() => {
    window.__smokeAudio = { count: 0, last: null, errors: [] };
    const realPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        window.__smokeAudio.count += 1;
        window.__smokeAudio.last = this;
        const started = realPlay.call(this);
        if (started && typeof started.catch === 'function') {
            started.catch((error) => { window.__smokeAudio.errors.push(String(error && error.name)); });
        }
        return started;
    };
    return true;
})()`;

const READ_AUDIO_SCRIPT = `(() => {
    const watched = window.__smokeAudio;
    const element = watched.last;
    return {
        count: watched.count,
        src: element ? (element.currentSrc || element.src) : '',
        duration: element && Number.isFinite(element.duration) ? element.duration : 0,
        errorCode: element && element.error ? element.error.code : 0,
        errors: watched.errors.join(',')
    };
})()`;

/*
 * Criterion 8 in the packaged app: one tray icon however often it is asked for, a close raised by the system - Alt+F4,
 * a session ending - that hides the window while the app is running, and a close that lets it go once the app is
 * quitting. The titlebar's X is a different path as of 2026-09-13: it asks app:quit, which ends the process, and the
 * smoke cannot take that path without ending itself. What it proves is the consequence - that once the app is
 * quitting nothing re-hides the window. The quitting flag is set at the very end on purpose: nothing runs after it
 * but the report.
 */
async function checkShell(lines: string[]): Promise<string | null> {
    try {
        const actions = { show: () => undefined, hide: () => undefined, isVisible: () => false };
        const log = (line: string): void => { lines.push('SMOKE_TRAY_LOG=' + line); };
        const first = createAppTray(actions, log);
        const second = createAppTray(actions, log);
        lines.push('SMOKE_TRAY_CREATED=' + String(first !== undefined));
        lines.push('SMOKE_TRAY_SINGLETON=' + String(first === second));

        // A window of its own, so the one the renderer checks ran against is left alone. The finally is IN-07: a
        // throw between the two closes used to leave it in `created`, where the renderer bus would still deliver to it.
        const probe = createMainWindow({ show: false });
        try {
            lines.push('SMOKE_SYSTEM_CLOSE_DECISION=' + decideWindowClose({ quitting: false, hasTray: hasAppTray() }));
            // WR-03: the same question in the state a failed new Tray() leaves the app in, where hiding would be a
            // process only Task Manager can end.
            lines.push('SMOKE_NO_TRAY_CLOSE_DECISION=' + decideWindowClose({ quitting: false, hasTray: false }));
            probe.close();
            // A close that is allowed through destroys the window on a later turn of the loop, so both readings wait.
            await settled(probe);
            lines.push('SMOKE_WINDOW_AFTER_SYSTEM_CLOSE=' + (probe.isDestroyed() ? 'destroyed' : 'alive'));

            markQuitting();
            lines.push('SMOKE_QUIT_DECISION=' + decideWindowClose({ quitting: true, hasTray: hasAppTray() }));
            if (!probe.isDestroyed()) {
                probe.close();
                await settled(probe);
            }
            lines.push('SMOKE_WINDOW_AFTER_QUIT=' + (probe.isDestroyed() ? 'destroyed' : 'alive'));
        } finally {
            if (!probe.isDestroyed()) {
                probe.destroy();
            }
            destroyAppTray();
        }
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
        const rendered = await waitForRendererText(win, RENDERER_MARKER_TEXT);
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

        // SPA-01, last because it leaves the page on Home again and the checks above expect to find it there.
        const routing = await probeRouting(win, lines);
        if (routing !== null) {
            return routing;
        }

        const assets = await probeAssets(win, lines);
        if (assets !== null) {
            return assets;
        }
    } catch (error) {
        return 'renderer: ' + describeError(error);
    }
    return null;
}

/*
 * SPA-08: networking off for the whole launch, and every remote request counted.
 *
 * enableNetworkEmulation is the switch; the webRequest filter is the witness. Together they answer the question
 * criterion 2 actually asks - not "does it look right online" but "did anything try to leave the machine". file://
 * never matches the filter, so the app's own documents and assets are untouched by it.
 */
function goOffline(lines: string[]): () => number {
    let attempts = 0;
    const ses = session.defaultSession;
    ses.enableNetworkEmulation({ offline: true });
    ses.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
        (details, callback) => {
            attempts += 1;
            lines.push('SMOKE_OFFLINE_REQUEST=' + details.url);
            callback({ cancel: true });
        }
    );
    return () => attempts;
}

/*
 * SPA-08/SPA-09 inside the packaged app, with networking already off.
 *
 * The measurement is the one that separates a working icon font from the failure C4 describes: a
 * .material-symbols-outlined span holding an icon name renders as ONE glyph roughly as wide as the font size, while
 * the same name without the icon font renders as the literal words and is several times wider. A control span with
 * the same text at the same size is measured beside it, so the assertion is a comparison rather than a magic number.
 *
 * The FILL reading is the other half. The bottom navigation marks its active tab with a Tailwind
 * arbitrary-property utility, and a utility whose CSS was never emitted leaves the computed value empty - which is
 * how C3 shows up. Reading it off the live element is how that gets noticed here instead of by eye in Phase 8.
 */
async function probeAssets(win: BrowserWindow, lines: string[]): Promise<string | null> {
    try {
        const measured = asRecord(await win.webContents.executeJavaScript(assetProbeScript()));
        lines.push('SMOKE_ICON_WIDTH=' + text(measured.iconWidth));
        lines.push('SMOKE_ICON_TEXT_WIDTH=' + text(measured.textWidth));
        lines.push('SMOKE_ICON_FILL=' + text(measured.fill));
        lines.push('SMOKE_FONTS_LOADED=' + text(measured.fonts));

        const loaded = String(measured.fonts);
        const missing = SMOKE_BUNDLED_FONTS.filter((family) => !loaded.includes(family));
        if (missing.length > 0) {
            return 'these font families never loaded with networking off: ' + missing.join(', ');
        }
        if (typeof measured.iconWidth !== 'number' || typeof measured.textWidth !== 'number') {
            return 'the icon probe measured nothing: ' + text(measured);
        }
    } catch (error) {
        return 'assets: ' + describeError(error);
    }
    return null;
}

/** The icon name and the size are configuration, so the script that uses them is built from the constants. */
function assetProbeScript(): string {
    const size = String(SMOKE_ICON_FONT_SIZE_PX);
    const name = JSON.stringify(SMOKE_ICON_NAME);
    return [
        '(async () => {',
        '    await document.fonts.ready;',
        '    const host = document.createElement("div");',
        '    host.style.cssText = "position:absolute;left:-9999px;top:0";',
        '    const icon = document.createElement("span");',
        '    icon.className = "material-symbols-outlined";',
        '    icon.style.fontSize = "' + size + 'px";',
        '    icon.textContent = ' + name + ';',
        '    const control = document.createElement("span");',
        '    control.style.fontSize = "' + size + 'px";',
        '    control.textContent = ' + name + ';',
        '    host.appendChild(icon);',
        '    host.appendChild(control);',
        '    document.body.appendChild(host);',
        '    const active = document.querySelector(' + JSON.stringify('[aria-current="page"] .material-symbols-outlined') + ');',
        '    const measured = {',
        '        iconWidth: icon.offsetWidth,',
        '        textWidth: control.offsetWidth,',
        '        fill: active ? getComputedStyle(active).fontVariationSettings : "",',
        '        fonts: Array.from(document.fonts)',
        '            .filter((face) => face.status === "loaded").map((face) => face.family).join("|")',
        '    };',
        '    host.remove();',
        '    return measured;',
        '})()'
    ].join('\n');
}

/*
 * SPA-10 end to end: main decides a sound is due, the renderer plays one, and what it plays is a file inside the
 * app. HTMLMediaElement.play is wrapped before the event is raised, because the element the renderer creates is
 * private to it - the wrapper is how the page reports which src was asked for and whether the bytes decoded.
 */
async function checkSound(win: BrowserWindow, container: AppContainer, lines: string[]): Promise<string | null> {
    try {
        await win.webContents.executeJavaScript(WATCH_AUDIO_SCRIPT);
        container.ports.sound.play(SMOKE_SOUND_ID);
        await new Promise((done) => setTimeout(done, SMOKE_TICK_WAIT_MS));
        const played = asRecord(await win.webContents.executeJavaScript(READ_AUDIO_SCRIPT));

        lines.push('SMOKE_SOUND_PLAYS=' + text(played.count));
        lines.push('SMOKE_SOUND_SRC=' + text(played.src));
        lines.push('SMOKE_SOUND_DURATION=' + text(played.duration));
        lines.push('SMOKE_SOUND_ERROR=' + text(played.errorCode));
        lines.push('SMOKE_SOUND_REJECTIONS=' + text(played.errors));

        if (typeof played.count !== 'number' || played.count < 1) {
            return 'main asked for a sound and the renderer played none';
        }
        const src = typeof played.src === 'string' ? played.src : '';
        if (!src.startsWith('file:')) {
            return 'the sound was played from ' + src + ', which is not a file inside the app';
        }
    } catch (error) {
        return 'sound: ' + describeError(error);
    }
    return null;
}

/**
 * The text serialisation of a value, as a browser writes it into a text node: `&`, `<` and `>` and nothing else.
 * Quotes are left alone there, which is why this is not an attribute escape.
 */
const asTextNode = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/*
 * Criterion 1 / S2, in the packaged app: a company whose NAME is an image tag with an onerror on it, shown on the
 * screen that shows companies.
 *
 * This is the only place in the repository that can watch the escaping happen. There is no jsdom here and no test
 * renders a component, so every other assertion about S2 is about the source: that no renderer file reaches a
 * markup sink, and that lint would refuse one. Neither says what the browser did with the string.
 *
 * Three answers, because each alone can be true for the wrong reason. The name reads back as TEXT (so it was
 * rendered at all). No element with that src or that onerror exists inside #root (so it was not parsed as markup -
 * the app's own logo is an <img>, which is why the filter is on the attributes rather than on the tag). And the
 * markup carries the ESCAPED form (so the first two are not both true because the row is missing).
 */
async function checkEscaping(win: BrowserWindow, container: AppContainer, lines: string[]): Promise<string | null> {
    // Removed again at the end: the legacy-migration case counts the companies this launch leaves behind, and a
    // probe that changes what another check measures is a probe that breaks it.
    let probeCompanyId: number | null = null;
    try {
        probeCompanyId = container.services.companies
            .create({ name: SMOKE_XSS_COMPANY_NAME, noteRequired: false }).id;
        await win.webContents.executeJavaScript(
            'window.location.hash = ' + JSON.stringify(RENDERER_COMPANIES_ROUTE_HASH) + '; true'
        );
        const rendered = await waitForRendererText(win, SMOKE_XSS_COMPANY_NAME);
        const asText = rendered.includes(SMOKE_XSS_COMPANY_NAME);
        const probe = asRecord(await win.webContents.executeJavaScript(
            escapingProbeScript(asTextNode(SMOKE_XSS_COMPANY_NAME))
        ));

        // The name itself, so the harness checks the payload it thinks it is checking (D-24).
        lines.push('SMOKE_XSS_NAME=' + SMOKE_XSS_COMPANY_NAME);
        lines.push('SMOKE_XSS_AS_TEXT=' + String(asText));
        lines.push('SMOKE_XSS_ELEMENTS=' + text(probe.elements));
        lines.push('SMOKE_XSS_ESCAPED=' + text(probe.escaped));

        if (!asText) {
            return 'the company name never reached the screen as text, so nothing about escaping was observed';
        }
        if (probe.elements !== 0) {
            return 'the company name was parsed as markup: ' + text(probe.elements) + ' injected element(s) (S2)';
        }
        if (probe.escaped !== true) {
            return 'the page does not carry the escaped name, so the two answers above are about something else';
        }

        // Home again, so the rest of the launch finds the marker where it expects it.
        await win.webContents.executeJavaScript('window.location.hash = "#/"; true');
        await waitForRendererText(win, RENDERER_MARKER_TEXT);
    } catch (error) {
        return 'escaping: ' + describeError(error);
    } finally {
        if (probeCompanyId !== null) {
            container.services.companies.remove(probeCompanyId);
        }
    }
    return null;
}

const escapingProbeScript = (escaped: string): string => `(() => {
    const root = document.getElementById('root');
    if (root === null) return { elements: -1, escaped: false };
    const suspects = [...root.querySelectorAll('img, script, object, iframe')]
        .filter((el) => el.getAttribute('src') === 'x' || el.hasAttribute('onerror'));
    return { elements: suspects.length, escaped: root.innerHTML.includes(${JSON.stringify(escaped)}) };
})()`;

/*
 * SPA-01 in the packaged app: the second route is reached, and no document is loaded to reach it.
 *
 * v1.2.1 changed screens by asking main to loadFile() a different HTML file, so every screen change was a fresh
 * document, a fresh script evaluation and a fresh set of globals. The claim now is that there is one document and
 * the route lives after the #. did-navigate fires for a document navigation and did-navigate-in-page for a
 * same-document one, so the two counters say which kind actually happened - and the URL is compared with its
 * fragment stripped, which is the part a loadFile would have changed.
 */
async function probeRouting(win: BrowserWindow, lines: string[]): Promise<string | null> {
    const documentOf = (url: string): string => url.split('#')[0] ?? url;

    let documentLoads = 0;
    let inPageChanges = 0;
    const onNavigate = (): void => { documentLoads += 1; };
    const onNavigateInPage = (): void => { inPageChanges += 1; };
    win.webContents.on('did-navigate', onNavigate);
    win.webContents.on('did-navigate-in-page', onNavigateInPage);

    try {
        const before = documentOf(win.webContents.getURL());
        await win.webContents.executeJavaScript(
            'window.location.hash = ' + JSON.stringify(RENDERER_SECOND_ROUTE_HASH) + '; true'
        );
        const rendered = await waitForRendererText(win, RENDERER_SECOND_ROUTE_TEXT);
        const after = documentOf(win.webContents.getURL());

        lines.push('SMOKE_ROUTE_TEXT=' + rendered);
        lines.push('SMOKE_ROUTE_HASH=' + (win.webContents.getURL().split('#')[1] ?? ''));
        lines.push('SMOKE_ROUTE_SAME_DOCUMENT=' + String(before === after));
        lines.push('SMOKE_ROUTE_DOCUMENT_LOADS=' + String(documentLoads));
        lines.push('SMOKE_ROUTE_IN_PAGE=' + String(inPageChanges));

        if (!rendered.includes(RENDERER_SECOND_ROUTE_TEXT)) {
            return 'the ' + RENDERER_SECOND_ROUTE_HASH + ' route never rendered "' + RENDERER_SECOND_ROUTE_TEXT + '"';
        }
        if (before !== after) {
            return 'the route change replaced the document: ' + before + ' -> ' + after;
        }
        if (documentLoads > 0) {
            return 'the route change loaded ' + String(documentLoads) + ' document(s); a screen change must load none';
        }

        // Back to Home, so the marker the rest of the smoke waits for is on screen again.
        await win.webContents.executeJavaScript('window.location.hash = "#/"; true');
        const home = await waitForRendererText(win, RENDERER_MARKER_TEXT);
        if (!home.includes(RENDERER_MARKER_TEXT)) {
            return 'the app did not route back to "' + RENDERER_MARKER_TEXT + '"';
        }
    } finally {
        win.webContents.off('did-navigate', onNavigate);
        win.webContents.off('did-navigate-in-page', onNavigateInPage);
    }
    return null;
}

/*
 * Criterion 4 in the packaged app: the settings the screen shows are the ones on disk, and the one irreversible
 * button on it is reached by an identifier rather than by where it happens to sit.
 *
 * v1.2.1 found the delete-all-data button with document.querySelector('.mt-8.mb-8 button'), so a spacing tweak
 * detached the handler - or hung it on whatever button a later edit put first inside those margins. Both halves are
 * asked here: the handle resolves to exactly one element, and the selector that used to find it resolves to none.
 *
 * The switch is asked about too, because its markup changed. v1.2.1 drew `has-[:checked]:`; the row is one <label>
 * now and the track is styled `peer-checked:`, which only works while the input is the track's own sibling. Nothing
 * outside a browser can tell whether that is still true - a switch that never moves is a checkbox that works
 * perfectly and a control that lies.
 */
async function checkSettingsScreen(win: BrowserWindow, lines: string[]): Promise<string | null> {
    try {
        await win.webContents.executeJavaScript(
            'window.location.hash = ' + JSON.stringify(RENDERER_SECOND_ROUTE_HASH) + '; true'
        );
        const rendered = await waitForRendererText(win, SMOKE_SETTINGS_TARGET_TEXT);
        const probe = asRecord(await win.webContents.executeJavaScript(
            settingsProbeScript(RENDERER_DESTRUCTIVE_TESTID, RENDERER_LEGACY_DESTRUCTIVE_SELECTOR)
        ));

        lines.push('SMOKE_SETTINGS_TARGET=' + String(rendered.includes(SMOKE_SETTINGS_TARGET_TEXT)));
        lines.push('SMOKE_SETTINGS_HANDLE=' + text(probe.handle));
        lines.push('SMOKE_SETTINGS_LEGACY_HANDLE=' + text(probe.legacy));
        lines.push('SMOKE_SETTINGS_SWITCH=' + text(probe.switchJustify));
        lines.push('SMOKE_SETTINGS_DURATIONS=' + text(probe.durations));

        if (!rendered.includes(SMOKE_SETTINGS_TARGET_TEXT)) {
            return 'the settings route never showed the stored daily target ' + SMOKE_SETTINGS_TARGET_TEXT;
        }
        if (probe.handle !== 1) {
            return 'the delete-all button answered to its identifier ' + text(probe.handle) + ' times';
        }
        if (probe.legacy !== 0) {
            return "v1.2.1's '" + RENDERER_LEGACY_DESTRUCTIVE_SELECTOR + "' found " + text(probe.legacy) +
                ' button(s): the danger zone has reproduced the selector that used to identify this one';
        }
        if (probe.switchJustify !== 'flex-end') {
            return 'a checked switch left its knob at ' + text(probe.switchJustify) + ', so the control does not ' +
                'show the state it is in';
        }
        if (probe.durations !== SMOKE_SETTINGS_NUMBER_FIELDS) {
            return 'pomodoro is enabled on disk and the screen offered ' + text(probe.durations) + ' of its ' +
                String(SMOKE_SETTINGS_NUMBER_FIELDS) + ' durations';
        }

        // Home again, so the marker the rest of the launch waits for is on screen.
        await win.webContents.executeJavaScript('window.location.hash = "#/"; true');
        await waitForRendererText(win, RENDERER_MARKER_TEXT);
    } catch (error) {
        return 'settings: ' + describeError(error);
    }
    return null;
}

const settingsProbeScript = (testid: string, legacySelector: string): string => `(() => {
    const root = document.getElementById('root');
    if (root === null) return { handle: -1, legacy: -1, switchJustify: 'no-root', durations: -1 };
    const checked = root.querySelector('input.peer:checked');
    const track = checked === null ? null : checked.nextElementSibling;
    return {
        handle: root.querySelectorAll(${JSON.stringify('[data-testid="' + testid + '"]')}).length,
        legacy: root.querySelectorAll(${JSON.stringify(legacySelector)}).length,
        switchJustify: track === null ? 'none' : getComputedStyle(track).justifyContent,
        // NT-05: by the marker the four cards carry, not by input type - the old count answered 4 for any four
        // unrelated number inputs, so SMOKE_SETTINGS_DURATIONS did not mean what parity row 71 says it means.
        durations: root.querySelectorAll('[data-field="pomodoro-duration"]').length
    };
})()`;

/** Polls the page until #root has text containing the marker, or the timeout passes. */
async function waitForRendererText(win: BrowserWindow, marker: string): Promise<string> {
    const deadline = Date.now() + SMOKE_RENDER_TIMEOUT_MS;
    let text = '';
    while (Date.now() < deadline) {
        const value: unknown = await win.webContents.executeJavaScript(
            'document.getElementById("root") ? document.getElementById("root").textContent : ""'
        );
        text = typeof value === 'string' ? value : '';
        if (text.includes(marker)) {
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
        (await waitForRendererText(win, RENDERER_MARKER_TEXT)).includes(RENDERER_MARKER_TEXT);
    return { windowOpenBlocked, navigationBlocked: prevented && stillApp };
}

/** Writes the report and exits only once stdout has flushed it; pipes are asynchronous on macOS. */
export function finishSmoke(outcome: SmokeOutcome): void {
    if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
    }
    const code = outcome.code ?? (outcome.ok ? 0 : 1);
    const fallback = setTimeout(() => app.exit(code), SMOKE_EXIT_FALLBACK_MS);
    process.stdout.write(outcome.lines.join('\n') + '\n', () => {
        clearTimeout(fallback);
        app.exit(code);
    });
}

// The --smoke launch for tools/smoke-packaged.mjs: the real database bootstrap, reporting on stdout instead of a modal
// and recording exits rather than taking them. Four things are proved, and only those: the database opens (or is
// refused) the way startup decides, the window renders Home and Settings, main can ask the renderer for a sound, and
// the packaged app can build its services over the database it opened.

import { app, BrowserWindow } from 'electron';
import { isAbsolute, join } from 'node:path';
import fs from 'node:fs';
import type * as DatabaseLayerModule from '../lib/db';
import {
    DATABASE_RENAME_RELEASED, EXIT_CODES, PRODUCTION_DATA_DOOR_OPEN, RENDERER_MARKER_TEXT,
    RENDERER_SECOND_ROUTE_HASH, RENDERER_SECOND_ROUTE_TEXT, SMOKE_DB_ENV, SMOKE_EXIT_FALLBACK_MS,
    SMOKE_POLL_INTERVAL_MS, SMOKE_RENDER_TIMEOUT_MS, SMOKE_SOUND_ID, SMOKE_WATCHDOG_MS, mainConfig
} from './config';
import { clearActiveContainer, createContainer, setActiveContainer } from './container';
import type { AppContainer } from './container';
import { registerIpcHandlers, removeIpcHandlers } from './ipc';
import { startDatabase } from './database-startup';
import type { StartedDatabase } from './database-startup';
import { describeError } from './errors';
import { createHideNoticeStore } from './lifecycle';
import { readLegacyStorage } from './legacy-storage';
import { isSameOrInside } from './userdata-path';
import { createMainWindow, loadRenderer, registerHideNoticeStore, shellControls } from './window';

export type SmokeDatabase = typeof DatabaseLayerModule;

interface SmokeOutcome {
    ok: boolean;
    lines: string[];
    /** An exit code startup asked for; absent means the smoke's own 0/1 verdict stands. */
    code?: number;
}

let watchdog: NodeJS.Timeout | undefined;
// The report so far, so a run killed by the watchdog still says how far it got rather than only that it stopped.
let reportedSoFar: readonly string[] = [];

/*
 * A hung smoke launch is a process with no window and no tray, which nothing but a task manager can end. It ends
 * itself instead, and it ends FAILING: a watchdog that exited 0 would hide a real failure. unref'd, so it can never
 * itself be the reason the process is still alive.
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
    const lines = ['SMOKE_APP_NAME=' + appName, 'SMOKE_USER_DATA=' + userData];
    armWatchdog(lines);
    const fail = (reason: string): SmokeOutcome => ({ ok: false, lines: [...lines, 'SMOKE_FAIL=' + reason] });

    /*
     * The safety half: a smoke launch must never be able to touch a real database. It opens only a path it was handed,
     * that path must be new, and neither it nor userData may sit inside the production directory.
     */
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

    // The real bootstrap, over ports that print instead of showing a dialog or exiting.
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
                registerHideNoticeStore(createHideNoticeStore(layer, connection));
                win = createMainWindow({ show: false });
                // Muted, so a smoke run never comes out of the speakers; the sound check reads decode state.
                win.webContents.setAudioMuted(true);
                lines.push('SMOKE_WINDOW_CREATED=true');
            }
        }
    );
    if (started === null) {
        return { ok: false, lines, code: exitCode ?? 1 };
    }
    lines.push('SMOKE_DB_CLASS=' + started.report.dbClass);
    lines.push('SMOKE_DB_VERSION=' + String(started.report.toVersion));

    let container: AppContainer | undefined;
    try {
        // The composition root and one read through the bundled drizzle chunk, inside the packaged app.
        const built = buildContainer(layer, started.db, lines);
        if (typeof built === 'string') {
            return fail(built);
        }
        container = built;
        setActiveContainer(container);
        registerIpcHandlers({
            context: () => ({ ...built.services, shell: shellControls }),
            log: (line) => lines.push('SMOKE_IPC_LOG=' + line)
        });
        if (win === undefined) {
            return fail('startup returned a database without ever opening a main window');
        }
        const screensFailure = await checkScreens(win, lines);
        if (screensFailure !== null) {
            return fail(screensFailure);
        }
        const soundFailure = await checkSound(win, container, lines);
        if (soundFailure !== null) {
            return fail(soundFailure);
        }
    } finally {
        removeIpcHandlers();
        clearActiveContainer();
        // Before the window goes, so the -wal is folded back in even if a check threw.
        container?.dispose();
        started.close();
        win?.destroy();
    }

    lines.push('SMOKE_OK');
    return { ok: true, lines };
}

/** The caller disposes it. */
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
        lines.push('SMOKE_CONTAINER_TARGET=' + String(container.repositories.settings.get().dailyTargetSeconds));
        return container;
    } catch (error) {
        return 'container: ' + describeError(error);
    }
}

/** Home renders, and a route change reaches Settings without loading a new document. */
async function checkScreens(win: BrowserWindow, lines: string[]): Promise<string | null> {
    try {
        await loadRenderer(win);
        const home = await waitForRendererText(win, RENDERER_MARKER_TEXT);
        lines.push('SMOKE_HOME_RENDERED=' + String(home.includes(RENDERER_MARKER_TEXT)));
        if (!home.includes(RENDERER_MARKER_TEXT)) {
            return 'the renderer never rendered "' + RENDERER_MARKER_TEXT + '"';
        }

        await win.webContents.executeJavaScript(
            'window.location.hash = ' + JSON.stringify(RENDERER_SECOND_ROUTE_HASH) + '; true'
        );
        const settings = await waitForRendererText(win, RENDERER_SECOND_ROUTE_TEXT);
        lines.push('SMOKE_SETTINGS_RENDERED=' + String(settings.includes(RENDERER_SECOND_ROUTE_TEXT)));
        if (!settings.includes(RENDERER_SECOND_ROUTE_TEXT)) {
            return 'the ' + RENDERER_SECOND_ROUTE_HASH + ' route never rendered "' + RENDERER_SECOND_ROUTE_TEXT + '"';
        }
    } catch (error) {
        return 'renderer: ' + describeError(error);
    }
    return null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};

/** A value the page returned, as a line of the report. Nothing from a page is trusted to stringify itself. */
const text = (value: unknown): string =>
    typeof value === 'string' ? value
        : typeof value === 'number' || typeof value === 'boolean' ? String(value)
            : JSON.stringify(value) ?? 'undefined';

// Written as strings because they run in the page, not here. HTMLMediaElement.play is wrapped before the event is
// raised, because the element the renderer creates is private to it - the wrapper is how the page reports which src
// was asked for and whether the bytes decoded.
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

/* Main asks for a sound; the renderer must play a file from inside the bundle, and it must decode. */
async function checkSound(win: BrowserWindow, container: AppContainer, lines: string[]): Promise<string | null> {
    try {
        await win.webContents.executeJavaScript(WATCH_AUDIO_SCRIPT);
        container.ports.sound.play(SMOKE_SOUND_ID, 'classic');
        /*
         * Poll rather than wait a fixed time: on a cold first launch the element can still be loading its metadata
         * (duration 0, no error) when a fixed wait ends, which reads as an undecodable file. Done when it has a
         * duration or an error, or when the render timeout passes and the last read is judged as it stands.
         */
        const deadline = Date.now() + SMOKE_RENDER_TIMEOUT_MS;
        let played = asRecord(await win.webContents.executeJavaScript(READ_AUDIO_SCRIPT));
        while (Date.now() < deadline && !(Number(played.duration) > 0) && Number(played.errorCode) === 0) {
            await new Promise((done) => setTimeout(done, SMOKE_POLL_INTERVAL_MS));
            played = asRecord(await win.webContents.executeJavaScript(READ_AUDIO_SCRIPT));
        }

        lines.push('SMOKE_SOUND_PLAYS=' + text(played.count));
        lines.push('SMOKE_SOUND_SRC=' + text(played.src));
        lines.push('SMOKE_SOUND_DURATION=' + text(played.duration));
        lines.push('SMOKE_SOUND_ERROR=' + text(played.errorCode));

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

/** Polls the page until #root has text containing the marker, or the timeout passes. */
async function waitForRendererText(win: BrowserWindow, marker: string): Promise<string> {
    const deadline = Date.now() + SMOKE_RENDER_TIMEOUT_MS;
    let rendered = '';
    while (Date.now() < deadline) {
        const value: unknown = await win.webContents.executeJavaScript(
            'document.getElementById("root") ? document.getElementById("root").textContent : ""'
        );
        rendered = typeof value === 'string' ? value : '';
        if (rendered.includes(marker)) {
            return rendered;
        }
        await new Promise((done) => setTimeout(done, SMOKE_POLL_INTERVAL_MS));
    }
    return rendered;
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

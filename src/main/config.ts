// Every main-process constant, and the one read of process.env / process.argv (D-23).
// Import-free on purpose: loading it before the single-instance lock can open nothing.

export const SMOKE_FLAG = '--smoke';
export const SMOKE_DB_ENV = 'WORKFLOW_SMOKE_DB';
// D-37: a v1.2.1 timerState the smoke writes into its own temp profile's localStorage, so the next launch imports it.
export const SMOKE_SEED_TIMER_STATE_ENV = 'WORKFLOW_SMOKE_SEED_TIMER_STATE';
// Set by `electron-vite dev` to the renderer dev server's address.
export const RENDERER_URL_ENV = 'ELECTRON_RENDERER_URL';
/*
 * Text only the Home route renders, which the smoke launch waits for; tests/main-config.test.ts pins it to the
 * harness (D-24). A stat-card label rather than a heading, because Home has no visible heading - v1.2.1's
 * index.html carries a hidden one - and because "Home" is also the bottom navigation's first item, so a marker of
 * "Home" would be satisfied by the chrome even if the route itself rendered nothing.
 */
export const RENDERER_MARKER_TEXT = 'Daily Target';
// SPA-01: the second route the smoke visits, and the heading it must find there. Reaching it changes no document.
export const RENDERER_SECOND_ROUTE_HASH = '#/settings';
export const RENDERER_SECOND_ROUTE_TEXT = 'Settings';
/*
 * Criterion 1 / S2: the route that lists companies, and the name one of them is given. The payload is the brief's
 * own, verbatim - v1.2.1 built the row with innerHTML and hung an onclick= off the name, escaping the apostrophe
 * and nothing else, so this exact string ran. Escaped, it is text on a screen and there is no <img> at all.
 */
export const RENDERER_COMPANIES_ROUTE_HASH = '#/companies';
export const SMOKE_XSS_COMPANY_NAME = '<img src=x onerror=alert(1)>';
/*
 * Criterion 4: the handle the delete-all-data button is reached by on the settings route. v1.2.1 reached that exact
 * button with document.querySelector('.mt-8.mb-8 button') (legacy/pages/settings.html:659), so a spacing tweak
 * detached it; the smoke probes for this identifier and for that selector finding nothing.
 */
export const RENDERER_DESTRUCTIVE_TESTID = 'reset-all-data';
export const RENDERER_LEGACY_DESTRUCTIVE_SELECTOR = '.mt-8.mb-8 button';
/*
 * What the settings probe writes before the window loads, and what the screen must then show for it. Written
 * first, and not after: the form seeds its fields once, from what the database held when it opened.
 */
export const SMOKE_SETTINGS_TARGET_SECONDS = 27_000;
export const SMOKE_SETTINGS_TARGET_TEXT = '07:30';
/** The four numbers the pomodoro section offers once it is enabled (features/settings/settings-view.ts). */
export const SMOKE_SETTINGS_NUMBER_FIELDS = 4;
export const SMOKE_RENDER_TIMEOUT_MS = 20_000;
export const SMOKE_POLL_INTERVAL_MS = 100;
// If stdout never reports the write as flushed, exit anyway rather than hang.
export const SMOKE_EXIT_FALLBACK_MS = 3_000;
/*
 * The whole smoke launch's deadline. A smoke window is never shown and a smoke launch creates no tray, so a run that
 * hangs is a process with nothing to click and no way out but Task Manager - the WR-03 shape, applied to the test
 * harness instead of the app. Shorter than the harness's own 90 s kill (tools/smoke-packaged.mjs DEFAULT_TIMEOUT_MS),
 * so a stuck run names its own reason rather than being killed anonymously; tests/smoke-harness.test.ts holds the
 * two in that order.
 */
export const SMOKE_WATCHDOG_MS = 60_000;
// WR-01 smoke target: the .invalid TLD never resolves, so even a failed guard loads nothing remote.
export const SMOKE_ESCAPE_URL = 'https://example.invalid/';
export const SMOKE_NAVIGATION_TIMEOUT_MS = 5_000;
// Long enough for at least one main-process tick to cross the bus, the preload and the page (IPC-06 smoke check).
export const SMOKE_TICK_WAIT_MS = 1_500;

/*
 * SPA-08/SPA-09 smoke probe. The icon is rendered at this size and must measure about this wide as a GLYPH; the
 * same name as literal text is several times wider, which is exactly the failure self-hosting only the woff2
 * produces. SMOKE_ICON_MAX_WIDTH_PX leaves room for hinting; SMOKE_ICON_TEXT_MIN_WIDTH_PX is the width below which
 * the control would not prove the two are distinguishable.
 */
export const SMOKE_ICON_NAME = 'local_fire_department';
export const SMOKE_ICON_FONT_SIZE_PX = 24;
export const SMOKE_ICON_MAX_WIDTH_PX = 32;
export const SMOKE_ICON_TEXT_MIN_WIDTH_PX = 100;
/** The two families that must come from inside the bundle, spelled as their @font-face declares them (S4). */
export const SMOKE_BUNDLED_FONTS = Object.freeze(['Material Symbols Outlined', 'Inter Variable']);
/** The sound main asks the renderer to play in the smoke; it must resolve to a file inside the app (SPA-10). */
export const SMOKE_SOUND_ID = 'goalReached';
// flushStorageData is asynchronous; app.exit must not race it (D-37 seed mode).
export const SMOKE_STORAGE_FLUSH_MS = 1_000;

/** Appended to the application name to form the development userData directory name. */
export const DEVELOPMENT_USER_DATA_SUFFIX = '-dev';
/** The Chromium switch a launcher uses to name the userData directory explicitly. */
export const USER_DATA_DIR_SWITCH = 'user-data-dir';
// D-36: while false, a packaged non-smoke launch refuses the production krono.db. Only Phase 10 (REL-04) flips it.
export const PRODUCTION_DATA_DOOR_OPEN = false;

/*
 * V2-SCHEMA-02: while false, the app opens krono.db and adopts nothing, exactly as every shipped version has.
 * Flipping it is a one-way door for the user who takes that release: startup moves krono.db to workflow.db, and
 * v1.2.1 reinstalled afterwards finds no database and shows an empty app. The data is intact under the new name
 * and comes back by renaming the file, but the downgrade safety Phase 4 preserved ends here. Flipped once, with
 * PRODUCTION_DATA_DOOR_OPEN, at the release (REL-04/REL-05).
 */
export const DATABASE_RENAME_RELEASED = false;

// D-33: the legacy localStorage read is best effort, so it never blocks startup past this deadline.
export const LEGACY_STORAGE_TIMEOUT_MS = 5_000;

// D-30/D-31: each is distinct from 0 and 1, which stay the smoke's verdict and index.ts's catch-all.
export const EXIT_CODES = Object.freeze({
    doorClosed: 3,
    refusedNewer: 4,
    refusedUnrecognized: 5,
    databaseFailed: 6,
    smokeStuck: 7
});

// IPC-05: the width and height a new window opens at, and the size below which it cannot be resized. Phase 10's
// responsive matrix starts at 380x600, which is where the minimum comes from.
export const MAIN_WINDOW = Object.freeze({
    width: 430,
    height: 932,
    macHeight: 800,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: '#101c22',
    title: 'Workflow'
});

// IPC-05: a resize fires many times a second, so the bounds are written this long after the last one.
export const WINDOW_BOUNDS_SAVE_DEBOUNCE_MS = 500;
// Windows draws a full-size PNG in the notification area as a smear; v1.2.1 resized to 16 too (main.js:104).
export const TRAY_ICON_SIZE = 16;
export const TRAY_TOOLTIP = 'Workflow';

export interface MainConfig {
    readonly smoke: boolean;
    readonly smokeDbPath: string | undefined;
    readonly smokeSeedTimerState: string | undefined;
    readonly rendererDevUrl: string | undefined;
}

// Never throws: smoke.ts validates the database path, so a bad value becomes a SMOKE_FAIL report, not a crash.
export function parseMainConfig(env: Readonly<Record<string, string | undefined>>, argv: readonly string[]): MainConfig {
    const devUrl = env[RENDERER_URL_ENV];
    return Object.freeze({
        smoke: argv.includes(SMOKE_FLAG),
        smokeDbPath: env[SMOKE_DB_ENV],
        smokeSeedTimerState: env[SMOKE_SEED_TIMER_STATE_ENV],
        rendererDevUrl: typeof devUrl === 'string' && devUrl !== '' ? devUrl : undefined
    });
}

export const mainConfig: MainConfig = parseMainConfig(process.env, process.argv);

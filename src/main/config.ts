// Every main-process constant, and the one read of process.env / process.argv (D-23).
// Import-free on purpose: loading it before the single-instance lock can open nothing.

export const SMOKE_FLAG = '--smoke';
export const SMOKE_DB_ENV = 'WORKFLOW_SMOKE_DB';
// D-37: a v1.2.1 timerState the smoke writes into its own temp profile's localStorage, so the next launch imports it.
export const SMOKE_SEED_TIMER_STATE_ENV = 'WORKFLOW_SMOKE_SEED_TIMER_STATE';
// Set by `electron-vite dev` to the renderer dev server's address.
export const RENDERER_URL_ENV = 'ELECTRON_RENDERER_URL';
/*
 * Text only the Home route renders, which the smoke launch waits for (D-24, pinned by tests/main-config.test.ts). A
 * stat-card label rather than "Home", which the bottom nav would satisfy even if the route rendered nothing.
 */
export const RENDERER_MARKER_TEXT = 'Daily Target';
// SPA-01: the second route the smoke visits, and the heading it must find there. Reaching it changes no document.
export const RENDERER_SECOND_ROUTE_HASH = '#/settings';
export const RENDERER_SECOND_ROUTE_TEXT = 'Settings';
/*
 * Criterion 1 / S2: the brief's XSS payload verbatim. v1.2.1 built the row with innerHTML and hung an onclick= off
 * the name, escaping the apostrophe and nothing else, so this exact string ran.
 */
export const RENDERER_COMPANIES_ROUTE_HASH = '#/companies';
export const SMOKE_XSS_COMPANY_NAME = '<img src=x onerror=alert(1)>';
/*
 * Criterion 4: v1.2.1 reached the delete-all-data button with document.querySelector('.mt-8.mb-8 button')
 * (legacy/pages/settings.html:659), so a spacing tweak detached it. The smoke probes for this identifier, and for
 * that selector finding nothing.
 */
export const RENDERER_DESTRUCTIVE_TESTID = 'reset-all-data';
export const RENDERER_LEGACY_DESTRUCTIVE_SELECTOR = '.mt-8.mb-8 button';
// Written before the window loads, not after: the form seeds its fields once, from what the database held when it opened.
export const SMOKE_SETTINGS_TARGET_SECONDS = 27_000;
export const SMOKE_SETTINGS_TARGET_TEXT = '07:30';
/** The four numbers the pomodoro section offers once it is enabled (features/settings/settings-view.ts). */
export const SMOKE_SETTINGS_NUMBER_FIELDS = 4;
export const SMOKE_RENDER_TIMEOUT_MS = 20_000;
export const SMOKE_POLL_INTERVAL_MS = 100;
// If stdout never reports the write as flushed, exit anyway rather than hang.
export const SMOKE_EXIT_FALLBACK_MS = 3_000;
/*
 * The smoke launch's deadline: a smoke window is never shown and creates no tray, so a hung run has nothing to click
 * and no way out but Task Manager. Shorter than the harness's own 90 s kill (tools/smoke-packaged.mjs
 * DEFAULT_TIMEOUT_MS) so a stuck run names its own reason; tests/smoke-harness.test.ts holds the two in that order.
 */
export const SMOKE_WATCHDOG_MS = 60_000;
// WR-01 smoke target: the .invalid TLD never resolves, so even a failed guard loads nothing remote.
export const SMOKE_ESCAPE_URL = 'https://example.invalid/';
export const SMOKE_NAVIGATION_TIMEOUT_MS = 5_000;
// Long enough for at least one main-process tick to cross the bus, the preload and the page (IPC-06 smoke check).
export const SMOKE_TICK_WAIT_MS = 1_500;

/*
 * SPA-08/SPA-09: the icon must measure about this wide as a GLYPH. The same name rendered as literal text is several
 * times wider - the failure self-hosting only the woff2 produces. The max leaves room for hinting.
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

export const DEVELOPMENT_USER_DATA_SUFFIX = '-dev';
export const USER_DATA_DIR_SWITCH = 'user-data-dir';
// D-36: while false, a packaged non-smoke launch refuses the production krono.db. Only Phase 10 (REL-04) flips it.
export const PRODUCTION_DATA_DOOR_OPEN = false;

/*
 * V2-SCHEMA-02: while false, the app opens krono.db and adopts nothing, as every shipped version has. Flipping it is
 * a one-way door - startup renames krono.db to workflow.db, and v1.2.1 reinstalled afterwards finds no database. The
 * data comes back by renaming the file, but Phase 4's downgrade safety ends there. Flipped at the release (REL-04/05).
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

/*
 * MUST equal electron-builder.yml's appId - the identity the installer registers the Start Menu shortcut under. A
 * toast raised under any other one falls back to the Electron name and a default icon, which is the state the owner
 * photographed. tests/app-identity.test.ts reads the yml and holds the two equal.
 */
export const APP_USER_MODEL_ID = 'com.workflow.timer';

// IPC-05: a resize fires many times a second, so the bounds are written this long after the last one.
export const WINDOW_BOUNDS_SAVE_DEBOUNCE_MS = 500;
// Windows draws a full-size PNG in the notification area as a smear; v1.2.1 resized to 16 too (main.js:104).
export const TRAY_ICON_SIZE = 16;
export const TRAY_TOOLTIP = 'Workflow';

/*
 * REPO-06: the one thing this application asks the network for. The Pages site's own version.json, written by
 * publish-version.yml on release - not the releases API, which is rate limited per IP. Until the first v2 release
 * publishes it this URL is a 404, and a 404 is the same silence as no network. The host is the git remote's, and
 * tests/update-check.test.ts holds this URL to the repository field so the two cannot drift again.
 */
export const UPDATE_MANIFEST_URL = 'https://fleizean.github.io/workflow-timer/version.json';
export const UPDATE_RELEASES_URL = 'https://github.com/fleizean/workflow-timer/releases/latest';
// Long enough to be well clear of the first paint, short enough that a session shorter than this is a session that
// did not need telling.
export const UPDATE_FIRST_CHECK_DELAY_MS = 30_000;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// An unreachable host can hold a socket open indefinitely; nothing here is worth waiting on.
export const UPDATE_REQUEST_TIMEOUT_MS = 5_000;
// The real body is under 100 bytes. This is the ceiling on what a compromised or confused host can make main read.
export const UPDATE_MAX_RESPONSE_BYTES = 4_096;
/** Set to anything non-empty and the app never contacts the network at all. README.md documents it. */
export const UPDATE_CHECK_DISABLED_ENV = 'WORKFLOW_NO_UPDATE_CHECK';

export interface MainConfig {
    readonly smoke: boolean;
    readonly smokeDbPath: string | undefined;
    readonly smokeSeedTimerState: string | undefined;
    readonly rendererDevUrl: string | undefined;
    /** REPO-06: false when the user has set UPDATE_CHECK_DISABLED_ENV, and nothing is ever sent. */
    readonly updateCheck: boolean;
}

// Never throws: smoke.ts validates the database path, so a bad value becomes a SMOKE_FAIL report, not a crash.
export function parseMainConfig(env: Readonly<Record<string, string | undefined>>, argv: readonly string[]): MainConfig {
    const devUrl = env[RENDERER_URL_ENV];
    const optedOut = env[UPDATE_CHECK_DISABLED_ENV];
    return Object.freeze({
        smoke: argv.includes(SMOKE_FLAG),
        smokeDbPath: env[SMOKE_DB_ENV],
        smokeSeedTimerState: env[SMOKE_SEED_TIMER_STATE_ENV],
        rendererDevUrl: typeof devUrl === 'string' && devUrl !== '' ? devUrl : undefined,
        updateCheck: optedOut === undefined || optedOut === ''
    });
}

export const mainConfig: MainConfig = parseMainConfig(process.env, process.argv);

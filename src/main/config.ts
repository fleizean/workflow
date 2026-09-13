// Every main-process constant, and the one read of process.env / process.argv (D-23).
// Import-free on purpose: loading it before the single-instance lock can open nothing.

export const SMOKE_FLAG = '--smoke';
export const SMOKE_DB_ENV = 'WORKFLOW_SMOKE_DB';
// D-37: a v1.2.1 timerState the smoke writes into its own temp profile's localStorage, so the next launch imports it.
export const SMOKE_SEED_TIMER_STATE_ENV = 'WORKFLOW_SMOKE_SEED_TIMER_STATE';
// Set by `electron-vite dev` to the renderer dev server's address.
export const RENDERER_URL_ENV = 'ELECTRON_RENDERER_URL';
// The Home route's heading, which the smoke launch waits for; tests/main-config.test.ts pins it to the harness.
export const RENDERER_MARKER_TEXT = 'Home';
// SPA-01: the second route the smoke visits, and the heading it must find there. Reaching it changes no document.
export const RENDERER_SECOND_ROUTE_HASH = '#/settings';
export const RENDERER_SECOND_ROUTE_TEXT = 'Settings';
export const SMOKE_RENDER_TIMEOUT_MS = 20_000;
export const SMOKE_POLL_INTERVAL_MS = 100;
// If stdout never reports the write as flushed, exit anyway rather than hang.
export const SMOKE_EXIT_FALLBACK_MS = 3_000;
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

// D-33: the legacy localStorage read is best effort, so it never blocks startup past this deadline.
export const LEGACY_STORAGE_TIMEOUT_MS = 5_000;

// D-30/D-31: each is distinct from 0 and 1, which stay the smoke's verdict and index.ts's catch-all.
export const EXIT_CODES = Object.freeze({
    doorClosed: 3,
    refusedNewer: 4,
    refusedUnrecognized: 5,
    databaseFailed: 6
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

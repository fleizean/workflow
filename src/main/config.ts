// Every main-process constant, and the one read of process.env / process.argv (D-23).
// Import-free on purpose: loading it before the single-instance lock can open nothing.

export const SMOKE_FLAG = '--smoke';
export const SMOKE_DB_ENV = 'WORKFLOW_SMOKE_DB';
// Set by `electron-vite dev` to the renderer dev server's address.
export const RENDERER_URL_ENV = 'ELECTRON_RENDERER_URL';
// The Home route's heading, which the smoke launch waits for; tests/main-config.test.ts pins it to the harness.
export const RENDERER_MARKER_TEXT = 'Home';
export const SMOKE_RENDER_TIMEOUT_MS = 20_000;
export const SMOKE_POLL_INTERVAL_MS = 100;
// If stdout never reports the write as flushed, exit anyway rather than hang.
export const SMOKE_EXIT_FALLBACK_MS = 3_000;
// WR-01 smoke target: the .invalid TLD never resolves, so even a failed guard loads nothing remote.
export const SMOKE_ESCAPE_URL = 'https://example.invalid/';
export const SMOKE_NAVIGATION_TIMEOUT_MS = 5_000;

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

// minWidth/minHeight are declared, not applied: enforcing a minimum size is IPC-05 (Phase 6).
export const MAIN_WINDOW = Object.freeze({
    width: 430,
    height: 932,
    macHeight: 800,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: '#101c22',
    title: 'Workflow'
});

export interface MainConfig {
    readonly smoke: boolean;
    readonly smokeDbPath: string | undefined;
    readonly rendererDevUrl: string | undefined;
}

// Never throws: smoke.ts validates the database path, so a bad value becomes a SMOKE_FAIL report, not a crash.
export function parseMainConfig(env: Readonly<Record<string, string | undefined>>, argv: readonly string[]): MainConfig {
    const devUrl = env[RENDERER_URL_ENV];
    return Object.freeze({
        smoke: argv.includes(SMOKE_FLAG),
        smokeDbPath: env[SMOKE_DB_ENV],
        rendererDevUrl: typeof devUrl === 'string' && devUrl !== '' ? devUrl : undefined
    });
}

export const mainConfig: MainConfig = parseMainConfig(process.env, process.argv);

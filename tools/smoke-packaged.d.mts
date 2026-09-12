// Type contract for what tools/smoke-packaged.mjs exports, so strict TypeScript tests can import them (TS7016).
// Functions stay undeclared until a TypeScript test needs one.

export declare const EXPECTED_APP_NAME: string;
export declare const PRODUCT_NAME: string;
export declare const SMOKE_DB_ENV: string;
export declare const SMOKE_DB_NAME: string;
export declare const RENDERER_MARKER_TEXT: string;
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const DATABASE_FILE: string;
export declare const BACKUP_DIR: string;
export declare const EXPECTED_LATEST: number;
export declare function isWithin(parent: string, child: string): boolean;

export interface SmokeCheck {
    readonly label: string;
    readonly pass: boolean;
    readonly detail: string;
}

export interface SmokeReport {
    readonly ok: boolean;
    readonly fields: Readonly<Record<string, string>>;
}

export interface DatabaseObservation {
    readonly userVersion: number;
    readonly companies: number;
    readonly workSessions: number;
    readonly pomodoroSessions: number;
    readonly totalDuration: number;
    readonly unassignedCompanies: number;
    readonly nullCompanySessions: number;
    readonly settings: readonly { key: string; value: string }[];
    readonly settingsByKey: Readonly<Record<string, string>>;
}

export declare const LEGACY_TIMER_KEY: string;
export declare const SMOKE_SEED_TIMER_STATE_ENV: string;
export declare const EXPECTED_EXIT_CODES: Readonly<Record<string, number>>;

export interface LaunchExit {
    readonly code: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly error?: string;
}

export interface StoredLegacyTimer {
    readonly raw: string;
    readonly elapsedSeconds: number | null;
    readonly wasRunning?: boolean | null;
    readonly lastUpdated?: number | null;
}

export declare function parseSmokeReport(stdout: string): SmokeReport;
export declare function evaluateRefusalCase(observed: {
    exit: LaunchExit;
    report: SmokeReport;
    hashBefore: string;
    hashAfter: string;
    smokeDbExists: boolean;
}): SmokeCheck[];
export declare function evaluateTimerCase(observed: {
    report: SmokeReport;
    seeded: { raw: string; elapsedSeconds: number };
    stored: StoredLegacyTimer | null;
    workSessions: number;
}): SmokeCheck[];
export declare function evaluateWalFlushed(observed: {
    caseName: string;
    exists: boolean;
    size: number;
}): SmokeCheck;
export declare function evaluateFreshCase(observed: { report: SmokeReport }): SmokeCheck[];
export declare function evaluateLegacyCase(observed: {
    report: SmokeReport;
    before: DatabaseObservation;
    after: DatabaseObservation;
    backups: readonly string[];
}): SmokeCheck[];

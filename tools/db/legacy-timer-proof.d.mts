// Type contract for what tools/db/legacy-timer-proof.mjs exports, so strict TypeScript tests can import them (TS7016).

export declare const MODES: readonly string[];
export declare const OWNER_TOKEN: string;
export declare const START_SELECTOR: string;
export declare const TIMER_STATE_KEY: string;
export declare const PINNED_FILES: readonly string[];
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const RUN_MS: number;

export interface ProofArgs {
    readonly mode: string | null;
    readonly hardKill: boolean;
    readonly ownerApproved: string | null;
}

export interface ManifestPin {
    readonly bytes: number;
    readonly sha256: string;
}

export interface VerifiedPin {
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
}

export interface StoredLegacyTimer {
    readonly raw: string;
    readonly elapsedSeconds: number | null;
}

export interface ImportObservation {
    readonly stored: StoredLegacyTimer | null;
    readonly workSessions: number;
}

export interface LaunchTarget {
    readonly executable: string;
    readonly args: readonly string[];
}

export interface ProofOptions {
    readonly mode?: string | null;
    readonly hardKill?: boolean;
    readonly ownerApproved?: string | null;
    readonly timeoutMs?: number;
    readonly productionDir?: string;
    readonly binary?: string;
    readonly distDir?: string;
}

export interface ProofDeps {
    readonly resolveLaunch?: () => LaunchTarget;
    readonly verifyPins?: () => readonly VerifiedPin[];
    readonly launchElectron?: (options: {
        executable: string;
        args: readonly string[];
        userDataDir: string;
        hardKill: boolean;
        timeoutMs: number;
        log: (line: string) => void;
    }) => Promise<{ raw: string | null }>;
    readonly launchSmoke?: (options: {
        binary: string;
        userDataDir: string;
        timeoutMs: number;
        env: Record<string, string>;
    }) => Promise<{ exit: { code: number | null; error?: string } }>;
    readonly hashFile?: (file: string) => string | null;
    readonly readFile?: (file: string) => Buffer;
    readonly observeImport?: (dbPath: string) => ImportObservation;
    readonly log?: (line: string) => void;
}

export interface ProofResult {
    readonly ok: boolean;
    readonly code: number;
    readonly refused?: boolean;
}

export declare function parseProofArgs(argv?: readonly string[]): ProofArgs;
export declare function parseManifestPins(markdown: string): Record<string, ManifestPin>;
export declare function verifyArchivedAppPins(
    manifestMarkdown: string,
    readFile: (file: string) => Buffer
): VerifiedPin[];
export declare function assertTempUserData(dir: string, productionDir: string): string;
export declare function elapsedOf(raw: string): { elapsedSeconds: number; running: boolean };
export declare function hashFile(file: string): string | null;
export declare function observeImport(dbPath: string): ImportObservation;
export declare function dryRunSeed(): { elapsedSeconds: number; raw: string };
export declare function runContinuityProof(options?: ProofOptions, deps?: ProofDeps): Promise<ProofResult>;

/*
 * Type contract for tools/ci/assert-package-contents.mjs.
 *
 * The script is plain JavaScript so that it runs on a packaging runner with nothing but Node, and
 * tests/packaging.test.ts is TypeScript under strict mode with noImplicitAny. Without this file the
 * test's import is an implicit any (TS7016) and the typecheck fails; with it, the test is checked
 * against the same shapes the script returns. Keep the two in step: a field added to the script's
 * return value and not declared here is invisible to the test.
 */

/** One file or link recorded in the archive header. */
export interface AsarEntry {
    /** Forward-slash path relative to the archive root, whatever the host platform. */
    path: string;
    /** Size in bytes as the header records it; 0 for a link. */
    size: number;
    /** True when the file lives in app.asar.unpacked on disk rather than inside the archive. */
    unpacked: boolean;
    /** Byte offset inside the data region; present only for files packed into the archive. */
    offset?: number;
    /** Link target; present only for symbolic-link entries. */
    link?: string;
}

export interface AsarHeader {
    /** Every file and link, sorted by path. Directories are implied by the paths. */
    entries: AsarEntry[];
    /** Size of the header pickle, from bytes 4-7. */
    headerBytes: number;
    /** Where the data region starts: 8 + headerBytes. */
    dataOffset: number;
    /** The archive's full length, against which every packed entry's extent was checked. */
    archiveBytes: number;
}

export interface DeniedMatch {
    /** The rule that matched, e.g. 'docs/' or '*.map'. */
    rule: string;
    /** Why that material must never reach a user's machine. */
    reason: string;
}

export interface DeniedEntry extends DeniedMatch {
    path: string;
}

export interface UnpackedRegionCheck {
    /** Paths in the region that are not part of the better-sqlite3 package. */
    offenders: string[];
    /** Region-level problems, such as no native addon being present at all. */
    problems: string[];
}

export interface PackageInspection {
    ok: boolean;
    appDir: string;
    resourcesDir: string;
    asarPath: string;
    entries: AsarEntry[];
    fileCount: number;
    totalBytes: number;
    /** The largest entries, biggest first - a measurement for the later bundle-size work. */
    largest: AsarEntry[];
    denied: DeniedEntry[];
    topLevelOffenders: string[];
    /** Every file under app.asar.unpacked, as forward-slash paths relative to it. */
    unpackedOnDisk: string[];
    /** The region check applied to what is on disk. */
    unpackedRegion: UnpackedRegionCheck;
    /** The region check applied to what the header marks unpacked. */
    headerUnpacked: UnpackedRegionCheck;
    /** Header entries marked unpacked that are not on disk - a load failure at runtime. */
    missingUnpacked: string[];
    /** Every failure, as one human-readable line each. Empty exactly when ok is true. */
    failures: string[];
}

export declare const ALLOWED_TOP_LEVEL: readonly string[];
export declare const UNPACKED_PACKAGE: string;
export declare const LARGEST_COUNT: number;

export declare class PackageNotFoundError extends Error {
    readonly appDir: string;
    readonly searched: readonly string[];
    constructor(appDir: string, searched: readonly string[]);
}

export declare function readAsarHeader(buffer: Buffer, archiveBytes?: number): AsarHeader;
export declare function readAsarFile(asarPath: string): AsarHeader;
export declare function matchDenied(packagedPath: string): DeniedMatch | null;
export declare function checkTopLevel(paths: readonly string[]): string[];
export declare function checkUnpackedRegion(paths: readonly string[]): UnpackedRegionCheck;
export declare function resolveResourcesDir(appDir: string): string;
export declare function listFilesUnder(dir: string): string[];
export declare function inspectPackage(appDir: string): PackageInspection;
export declare function formatReport(inspection: PackageInspection): string;

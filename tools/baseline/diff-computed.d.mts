// Type contract for tools/baseline/diff-computed.mjs, so strict TypeScript tests can import it (TS7016).
// Keep it in step with the script's exports.

export interface SettledEntry {
    page: string;
    prop: string;
    /** `v1` for a value only v1.2.1 rendered, `v2` for one only the SPA renders. */
    side: string;
    value: string;
    why: string;
}

export interface PageDifference {
    page: string;
    prop: string;
    side: string;
    value: string;
    why?: string;
}

export interface PageClassification {
    settled: PageDifference[];
    unexplained: PageDifference[];
}

export interface DiffResult {
    design: Record<string, PageClassification>;
    geometry: Record<string, PageClassification>;
}

export declare const PAGES: string[];
export declare const SIZES: string[];
export declare const DESIGN_PROPS: string[];
export declare const GEOMETRY_PROPS: string[];
export declare const SETTLED: SettledEntry[];

export declare function oklabToSrgb(L: number, a: number, b: number): number[];
export declare function colourToHex(fn: string, body: string): string | null;
export declare function resolveColours(value: string): string;
export declare function normalise(prop: string, rawValue: string): string;
export declare function splitTopLevel(value: string): string[];
export declare function visibleKeys(record: unknown): string[];
export declare function diffPage(
    baselineDir: string, v2Dir: string, page: string, props: string[]
): { prop: string; lost: string[]; gained: string[] }[];
export declare function settledReason(
    page: string, prop: string, side: string, value: string
): SettledEntry | undefined;
export declare function classifyPage(
    baselineDir: string, v2Dir: string, page: string, props: string[], explain: boolean
): PageClassification;
export declare function run(options?: { baselineDir?: string; v2Dir?: string }): DiffResult;
export declare function renderReport(result: DiffResult): string;

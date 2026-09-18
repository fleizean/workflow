// Type contract for tools/baseline/responsive-matrix.mjs, so strict TypeScript tests can import it (TS7016).
// Keep it in step with the script's exports.

export interface MatrixCheck {
    readonly label: string;
    readonly pass: boolean;
    readonly detail: string;
}

/** What the in-page measurement returns for one route in one cell. Shapes only; every number is measured. */
export interface RouteMeasurement {
    readonly modalOpen: boolean;
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly devicePixelRatio: number;
    readonly documentScrollWidth: number;
    readonly bodyScrollWidth: number;
    readonly shell: Record<string, number> | null;
    readonly nav: Record<string, number> | null;
    readonly dial: Record<string, number> | null;
    readonly canvas: Record<string, number> | null;
    readonly overflowing: readonly Record<string, string>[];
    readonly overflowingCount: number;
    readonly clipped: readonly Record<string, string>[];
    readonly clippedCount: number;
    readonly behindNav: readonly Record<string, string>[];
    readonly behindNavCount: number;
    readonly scrolled: Record<string, number> | null;
}

export declare const SCALES: readonly number[];
export declare const SIZES: readonly (readonly number[])[];
export declare const CELL_COUNT: number;
export declare const MODALS_NOT_REACHED: readonly (readonly string[])[];

export declare function judgeRoute(measured: unknown, size: readonly number[]): MatrixCheck[];
export declare function judgeModal(name: string, measured: unknown): MatrixCheck[];

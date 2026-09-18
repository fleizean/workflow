// Type contract for tools/offline-routes.mjs, so strict TypeScript tests can import it (TS7016).
// Keep it in step with the script's exports.

export interface OfflineCheck {
    readonly label: string;
    readonly pass: boolean;
    readonly detail: string;
}

export interface IconMeasurement {
    readonly name: string;
    readonly width: number;
    readonly fontSize: number;
    readonly ems: number;
    readonly fontFamily: string;
    readonly variation: string;
}

export interface RouteProbe {
    readonly fonts: Record<string, boolean>;
    readonly icons: readonly IconMeasurement[];
    readonly longestName: string;
    readonly nameAsTextEms: number;
    readonly bodyFont: string;
    readonly headingFont: string;
    readonly shellBackground: string;
    readonly violations: readonly string[];
}

export interface SoundProbe {
    readonly src: string;
    readonly duration: number;
    readonly error: string;
}

export declare const MAX_GLYPH_EMS: number;
export declare const MIN_NAME_EMS: number;
export declare const BUNDLED_FONTS: readonly string[];
export declare const FILL_ON: string;

export declare function judgeRouteOffline(route: string, probe: unknown, limits?: unknown): OfflineCheck[];
export declare function judgeSound(probe: unknown): OfflineCheck[];
export declare function insideThePackage(url: string): string;

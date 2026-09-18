// Type contract for tools/ci/assert-timezone.mjs, so strict TypeScript tests can import it (TS7016).
// Keep it in step with the script's exports.

export interface TimezoneProbe {
    resolvedZone: string;
    tzVariable: string | undefined;
    offsetAt(instant: number): number;
}

export interface TimezoneCheck {
    label: string;
    ok: boolean;
    detail: string;
}

export interface TimezoneOutcome {
    ok: boolean;
    zone: string;
    january: number;
    july: number;
    results: TimezoneCheck[];
}

export declare const JANUARY_INSTANT: number;
export declare const JULY_INSTANT: number;
/** Minutes, in getTimezoneOffset()'s sign convention: positive west of UTC. */
export declare const ZONE_OFFSETS: Readonly<Record<string, Readonly<{ january: number; july: number }>>>;

export declare function runtimeProbe(env?: Readonly<Record<string, string | undefined>>): TimezoneProbe;
export declare function checkTimezone(expectedZone: string, probe?: TimezoneProbe): TimezoneOutcome;
export declare function formatReport(outcome: TimezoneOutcome): string;

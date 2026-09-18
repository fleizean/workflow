// Type contract for the parts of tools/baseline/probe-userdata.mjs a strict TypeScript test imports (TS7016).
// The probe itself stays undeclared until a TypeScript test needs it.

export declare const SCRUBBED_ENV: readonly string[];
export declare const FORCED_CHILD_ENV: Readonly<Record<string, string>>;
export declare function childEnvironment(base?: Readonly<Record<string, string | undefined>>): {
    readonly env: Record<string, string | undefined>;
    readonly removed: string[];
};

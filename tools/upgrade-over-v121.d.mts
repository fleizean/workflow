// Type contract for tools/upgrade-over-v121.mjs, so strict TypeScript tests can import it (TS7016).

export interface UpgradeCheck {
    readonly label: string;
    readonly pass: boolean;
    readonly detail: string;
}

export declare const DAILY_TARGET_SECONDS: number;
export declare const STREAK_DAYS: number;

export declare function seedPopulatedV121(dbPath: string): unknown;
export declare function judgeUpgrade(observed: {
    seeded: unknown;
    read: unknown;
    backups: readonly string[];
}): UpgradeCheck[];

// Type contract for tools/second-instance.mjs, so strict TypeScript tests can import it (TS7016).

export interface SecondInstanceCheck {
    readonly label: string;
    readonly pass: boolean;
    readonly detail: string;
}

export declare const SECOND_EXIT_TIMEOUT_MS: number;

export declare function judgeSecondInstance(observed: unknown): SecondInstanceCheck[];

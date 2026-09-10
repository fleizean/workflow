// Error text for log lines and smoke reports, shared so the bootstrap never imports a module just for a formatter.
export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

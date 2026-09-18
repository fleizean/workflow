// A refusal a service made on purpose, carrying the code the wire uses (D-17). Anything else that reaches a handler
// is an accident, and an accident is INTERNAL: the renderer learns that the call failed and nothing about how.

export type ServiceErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT';

export class ServiceError extends Error {
    readonly code: ServiceErrorCode;

    constructor(code: ServiceErrorCode, message: string) {
        super(message);
        this.name = 'ServiceError';
        this.code = code;
    }
}

export const invalidInput = (message: string): ServiceError => new ServiceError('INVALID_INPUT', message);
export const notFound = (message: string): ServiceError => new ServiceError('NOT_FOUND', message);
export const conflict = (message: string): ServiceError => new ServiceError('CONFLICT', message);

/** The row a caller named, or a NOT_FOUND naming what was missing. Keeps a handler body free of a null branch. */
export function requireFound<T>(value: T | null | undefined, what: string): T {
    if (value === null || value === undefined) {
        throw notFound(what + ' does not exist.');
    }
    return value;
}

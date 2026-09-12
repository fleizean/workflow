// D-17: what crosses the wire when a call fails - a code from the closed list and a sentence, never a stack, a path
// or a driver message. A refusal a service made on purpose keeps its own words; anything else is INTERNAL.

import { ServiceError } from '../services/service-errors';
import type { IpcError } from '@shared/types';

export const INTERNAL_MESSAGE = 'Something went wrong and the action was not completed.';

/** Long enough to name the field that was refused, short enough that no payload can ride out inside it. */
export const MAX_ERROR_MESSAGE_LENGTH = 200;

const clipped = (message: string): string =>
    message.length <= MAX_ERROR_MESSAGE_LENGTH ? message : message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1) + '…';

export function toIpcError(error: unknown): IpcError {
    return error instanceof ServiceError
        ? { code: error.code, message: clipped(error.message) }
        : { code: 'INTERNAL', message: INTERNAL_MESSAGE };
}

/** The reason the input was refused, built from zod's issue paths so no rejected value is quoted back. */
export function invalidInputError(channel: string, issues: readonly { path: PropertyKey[]; message: string }[]): IpcError {
    const where = issues.slice(0, 3).map((issue) =>
        (issue.path.length === 0 ? channel : issue.path.map(String).join('.')) + ': ' + issue.message);
    return { code: 'INVALID_INPUT', message: clipped(channel + ' was refused - ' + where.join('; ')) };
}

// Criterion 7: the payload is validated here, in main, against the channel's own schema - before the handler exists,
// let alone before a service runs. A renderer that sends the wrong shape gets an IpcResult error and the database is
// never consulted.

import { ipcContract } from '@shared/ipc/contract';
import { invalidInputError, toIpcError } from './errors';
import type { IpcChannel, IpcHandlers, IpcOutput, IpcResult } from '@shared/types';

export interface DispatchInput {
    /** Resolved per call: the container is built after the database opens and cleared before it closes. */
    readonly handlers: () => IpcHandlers;
    readonly log: (line: string) => void;
}

export type Dispatch = <C extends IpcChannel>(channel: C, rawInput: unknown) => Promise<IpcResult<IpcOutput<C>>>;

const describe = (error: unknown): string => (error instanceof Error ? error.message : 'unknown');

export function createDispatch(input: DispatchInput): Dispatch {
    const { handlers, log } = input;

    return async function dispatch<C extends IpcChannel>(channel: C, rawInput: unknown) {
        const parsed = ipcContract[channel].input.safeParse(rawInput);
        if (!parsed.success) {
            return { ok: false, error: invalidInputError(channel, parsed.error.issues) };
        }
        try {
            // The map is keyed by C, so the handler and the parsed input belong together; the generic index cannot
            // say so on its own. Everything inside the cast has already been validated by the line above.
            const handler = handlers()[channel] as (value: unknown) => IpcOutput<C> | Promise<IpcOutput<C>>;
            return { ok: true, data: await handler(parsed.data) };
        } catch (error) {
            // The renderer is told a code; the reason stays here, where a log file is not a wire.
            log('ipc: ' + channel + ' failed - ' + describe(error));
            return { ok: false, error: toIpcError(error) };
        }
    };
}

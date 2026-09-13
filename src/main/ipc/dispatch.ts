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
    /**
     * Whether the answer is parsed against the contract as well as the payload (WR-05). On in development only:
     * the cost is real on a year of sessions, and the drift it catches is drift introduced while writing code.
     */
    readonly checkOutput?: boolean;
}

export type Dispatch = <C extends IpcChannel>(channel: C, rawInput: unknown) => Promise<IpcResult<IpcOutput<C>>>;

const describe = (error: unknown): string => (error instanceof Error ? error.message : 'unknown');

export function createDispatch(input: DispatchInput): Dispatch {
    const { checkOutput = false, handlers, log } = input;

    /** An answer the contract does not describe is a bug in main, so it is thrown and shaped as INTERNAL. */
    function checked<C extends IpcChannel>(channel: C, data: IpcOutput<C>): IpcOutput<C> {
        const answer = checkOutput ? ipcContract[channel].output.safeParse(data) : undefined;
        if (answer !== undefined && !answer.success) {
            throw new Error(channel + ' answered something the contract does not describe - ' +
                (answer.error.issues[0]?.message ?? 'no reason given'));
        }
        return data;
    }

    return async function dispatch<C extends IpcChannel>(channel: C, rawInput: unknown) {
        const parsed = ipcContract[channel].input.safeParse(rawInput);
        if (!parsed.success) {
            return { ok: false, error: invalidInputError(channel, parsed.error.issues) };
        }
        try {
            // The map is keyed by C, so the handler and the parsed input belong together; the generic index cannot
            // say so on its own. Everything inside the cast has already been validated by the line above.
            const handler = handlers()[channel] as (value: unknown) => IpcOutput<C> | Promise<IpcOutput<C>>;
            return { ok: true, data: checked(channel, await handler(parsed.data)) };
        } catch (error) {
            // The renderer is told a code; the reason stays here, where a log file is not a wire.
            log('ipc: ' + channel + ' failed - ' + describe(error));
            return { ok: false, error: toIpcError(error) };
        }
    };
}

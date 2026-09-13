// Criterion 7: the payload is validated here, in main, against the channel's own schema - before the handler exists,
// let alone before a service runs. A renderer that sends the wrong shape gets an IpcResult error and the database is
// never consulted.

import { ipcContract, ipcWrites } from '@shared/ipc/contract';
import { invalidInputError, toIpcError } from './errors';
import type { DataDomain, IpcChannel, IpcHandlers, IpcOutput, IpcResult } from '@shared/types';

export interface DispatchInput {
    /** Resolved per call: the container is built after the database opens and cleared before it closes. */
    readonly handlers: () => IpcHandlers;
    readonly log: (line: string) => void;
    /**
     * Whether the answer is parsed against the contract as well as the payload (WR-05). On in development only:
     * the cost is real on a year of sessions, and the drift it catches is drift introduced while writing code.
     */
    readonly checkOutput?: boolean;
    /**
     * SPA-07: what the call just changed, announced after the write landed. Best effort by design - the write has
     * already succeeded, so a bus that cannot deliver must not turn it into a failed call.
     */
    readonly announce?: (domains: readonly DataDomain[]) => void;
}

export type Dispatch = <C extends IpcChannel>(channel: C, rawInput: unknown) => Promise<IpcResult<IpcOutput<C>>>;

const describe = (error: unknown): string => (error instanceof Error ? error.message : 'unknown');

export function createDispatch(input: DispatchInput): Dispatch {
    const { announce, checkOutput = false, handlers, log } = input;

    /** An answer the contract does not describe is a bug in main, so it is thrown and shaped as INTERNAL. */
    function checked<C extends IpcChannel>(channel: C, data: IpcOutput<C>): IpcOutput<C> {
        const answer = checkOutput ? ipcContract[channel].output.safeParse(data) : undefined;
        if (answer !== undefined && !answer.success) {
            throw new Error(channel + ' answered something the contract does not describe - ' +
                (answer.error.issues[0]?.message ?? 'no reason given'));
        }
        return data;
    }

    /*
     * After the answer is shaped and before it is returned. The renderer is told which domains moved, not what they
     * now hold, so it refetches through the ordinary read channels - an event that carried rows would be a second
     * way for data to enter the cache, and the two would drift.
     */
    function announceChange(channel: IpcChannel): void {
        const domains = ipcWrites[channel];
        if (announce === undefined || domains.length === 0) {
            return;
        }
        try {
            announce(domains);
        } catch (error) {
            log('ipc: ' + channel + ' succeeded but its change was not announced - ' + describe(error));
        }
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
            const answer = await handler(parsed.data);
            // WR-07: the write has committed by here, whatever shape its answer turns out to be. checked() runs
            // the contract's output schema in dev, and running it first made a row that IS on disk arrive as
            // { ok: false } with nothing announced - training the developer that the write had failed.
            announceChange(channel);
            return { ok: true, data: checked(channel, answer) };
        } catch (error) {
            // The renderer is told a code; the reason stays here, where a log file is not a wire.
            log('ipc: ' + channel + ' failed - ' + describe(error));
            return { ok: false, error: toIpcError(error) };
        }
    };
}

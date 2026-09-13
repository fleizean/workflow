/*
 * The renderer's one door to the preload bridge (ARCH-03). Only a feature's api folder and app/providers open it.
 *
 * The bridge resolves every call to an IpcResult and never rejects, which is right for a wire format and wrong
 * for a caller: `const rows = await window.api['sessions:list']()` hands back a discriminated union that a
 * forgetful call site renders as an empty screen instead of an error. invoke() unwraps it, so a failure is a
 * rejected promise - which is what TanStack Query needs in order to have an error state at all (SPA-05).
 *
 * The bridge is read off globalThis rather than off `window`. contextBridge.exposeInMainWorld puts the key on the
 * renderer's global object, and in a document those are the same object - but only one of the two spellings lets
 * this module load in the node process the test suite runs in, which is what makes SPA-05 provable by running it
 * rather than by reading it.
 */

import { API_BRIDGE_KEY } from '@shared/constants/bridge';
import { INTERNAL_ERROR_MESSAGE } from '@shared/constants/ipc-errors';
import type { IpcErrorCode } from '@shared/constants/ipc-errors';
import type {
    IpcBridge, IpcChannel, IpcError, IpcEventChannel, IpcEventPayload, IpcInput, IpcOutput, IpcResult
} from '@shared/types';

/** A void channel takes no argument at all, exactly as the contract declares it. */
type Args<C extends IpcChannel> = [IpcInput<C>] extends [void] ? [] : [input: IpcInput<C>];

type BridgeCall = (input?: unknown) => Promise<IpcResult<unknown>>;

export class IpcCallError extends Error {
    readonly code: IpcErrorCode;
    readonly channel: IpcChannel;

    constructor(channel: IpcChannel, error: IpcError) {
        super(error.message);
        this.name = 'IpcCallError';
        this.code = error.code;
        this.channel = channel;
    }
}

/** Thrown when the page is open without the preload, which is a broken build rather than a failed call. */
const NO_BRIDGE: IpcError = { code: 'INTERNAL', message: INTERNAL_ERROR_MESSAGE };

const bridge = (): IpcBridge | undefined =>
    (globalThis as unknown as Record<string, IpcBridge | undefined>)[API_BRIDGE_KEY];

export async function invoke<C extends IpcChannel>(channel: C, ...args: Args<C>): Promise<IpcOutput<C>> {
    const call = (bridge() as unknown as Record<string, BridgeCall> | undefined)?.[channel];
    if (typeof call !== 'function') {
        throw new IpcCallError(channel, NO_BRIDGE);
    }
    const result = await call(...args);
    if (!result.ok) {
        throw new IpcCallError(channel, result.error);
    }
    return result.data as IpcOutput<C>;
}

/** Subscribes to a main-originated event and returns its disposer, unchanged from the bridge's own. */
export function subscribe<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void
): () => void {
    const on = bridge()?.on[channel];
    if (on === undefined) {
        // No bridge means no events will ever arrive; a disposer that does nothing is the honest answer.
        return () => undefined;
    }
    return on(listener);
}

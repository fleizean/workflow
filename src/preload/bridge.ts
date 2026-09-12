// IPC-01/IPC-06: the bridge, generated from the channel list so a channel added to the contract is reachable here
// without this file changing. Electron-free on purpose - index.ts hands it ipcRenderer, and a test hands it a fake.

import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '@shared/ipc/channels';
import type { IpcBridge } from '@shared/types';

export type EventForwarder = (event: unknown, payload: unknown) => void;

/** The slice of ipcRenderer the bridge uses. `off` and not `removeListener`: one name, so one thing to get wrong. */
export interface RendererIpc {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: EventForwarder): void;
    off(channel: string, listener: EventForwarder): void;
}

export function createIpcBridge(ipc: RendererIpc): IpcBridge {
    const bridge: Record<string, unknown> = {};
    for (const channel of IPC_CHANNELS) {
        // A void channel is called with no argument; sending undefined is what the contract's z.void() expects.
        bridge[channel] = (input?: unknown): Promise<unknown> => ipc.invoke(channel, input);
    }

    const subscriptions: Record<string, unknown> = {};
    for (const channel of IPC_EVENT_CHANNELS) {
        subscriptions[channel] = (listener: (payload: unknown) => void): (() => void) => {
            // The IpcRendererEvent stops here: it carries a sender the renderer has no business holding, and a
            // listener that received one would keep it alive for as long as the subscription lasted.
            const forward: EventForwarder = (_event, payload) => { listener(payload); };
            ipc.on(channel, forward);
            let disposed = false;
            return () => {
                // Idempotent: React StrictMode mounts an effect twice and disposes twice, and so does a fast route change.
                if (disposed) {
                    return;
                }
                disposed = true;
                ipc.off(channel, forward);
            };
        };
    }
    bridge.on = Object.freeze(subscriptions);

    // Built from the contract's own channel list, so the shape is the contract's; the cast is the one place that is said.
    return Object.freeze(bridge) as unknown as IpcBridge;
}

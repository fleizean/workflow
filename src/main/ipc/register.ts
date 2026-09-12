// IPC-01: every channel the contract declares is answered, from one place, and nothing else is. A channel added to
// the contract is registered here without this file changing - which is the point of deriving the list from it.

import { ipcMain } from 'electron';
import { ipcChannels } from '@shared/ipc/contract';
import { createDispatch } from './dispatch';
import { createHandlers } from './handlers';
import type { HandlerContext } from './handlers';

export interface RegisterIpcInput {
    /** Resolved per call, so a request that arrives before the database is open fails rather than holding a stale one. */
    readonly context: () => HandlerContext;
    readonly log: (line: string) => void;
}

let registered = false;

/** Registers once; returns the disposer that takes the channels back off ipcMain. */
export function registerIpcHandlers(input: RegisterIpcInput): () => void {
    if (registered) {
        return removeIpcHandlers;
    }
    registered = true;

    const dispatch = createDispatch({
        handlers: () => createHandlers(input.context()),
        log: input.log
    });

    for (const channel of ipcChannels) {
        ipcMain.handle(channel, (_event, rawInput: unknown) => dispatch(channel, rawInput));
    }
    return removeIpcHandlers;
}

export function removeIpcHandlers(): void {
    if (!registered) {
        return;
    }
    registered = false;
    for (const channel of ipcChannels) {
        ipcMain.removeHandler(channel);
    }
}

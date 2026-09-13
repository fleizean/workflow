// IPC-01: every channel the contract declares is answered, from one place, and nothing else is. A channel added to
// the contract is registered here without this file changing - which is the point of deriving the list from it.

import { ipcMain } from 'electron';
import { ipcChannels } from '@shared/ipc/contract';
import { mainConfig } from '../config';
import { createDispatch } from './dispatch';
import { createHandlers } from './handlers';
import type { HandlerContext } from './handlers';

export interface RegisterIpcInput {
    /** Resolved per call, so a request that arrives before the database is open fails rather than holding a stale one. */
    readonly context: () => HandlerContext;
    readonly log: (line: string) => void;
}

let registered = false;

/**
 * Registers once; returns the disposer that takes the channels back off ipcMain. A second call refuses rather than
 * pretending: its context and its log would be dropped on the floor, every channel would keep resolving through the
 * first caller's container, and the disposer it got back would unregister the first caller's channels. There is one
 * composition root, so a second call is a bug - and silently ignored is the one behaviour nobody can debug (WR-06).
 */
export function registerIpcHandlers(input: RegisterIpcInput): () => void {
    if (registered) {
        throw new Error('src/main/ipc/register.ts: the IPC handlers are already registered; ' +
            'call removeIpcHandlers() before registering a second context');
    }
    registered = true;

    const dispatch = createDispatch({
        handlers: () => createHandlers(input.context()),
        log: input.log,
        // ELECTRON_RENDERER_URL is set by electron-vite dev and by nothing else, so this is off in a packaged app.
        checkOutput: mainConfig.rendererDevUrl !== undefined
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

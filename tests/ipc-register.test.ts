// IPC-01: the contract's channels are registered on ipcMain from one place, once each, and taken off again when the
// database closes. ipcMain is a fake here - what is being checked is the registration, not Electron.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcContract } from '../src/shared/ipc/contract';
import type { HandlerContext } from '../src/main/ipc/handlers';
import type { IpcChannel } from '../src/shared/types';

type Listener = (event: unknown, input: unknown) => unknown;

const handlers = new Map<string, Listener>();
const registrations: string[] = [];
const removals: string[] = [];

vi.mock('electron', () => ({
    ipcMain: {
        handle(channel: string, listener: Listener) {
            registrations.push(channel);
            if (handlers.has(channel)) {
                // What the real ipcMain does, and the failure this file exists to catch.
                throw new Error('Attempted to register a second handler for \'' + channel + '\'');
            }
            handlers.set(channel, listener);
        },
        removeHandler(channel: string) {
            removals.push(channel);
            handlers.delete(channel);
        }
    }
}));

const { registerIpcHandlers, removeIpcHandlers } = await import('../src/main/ipc/register');

const CONTRACT_CHANNELS = Object.keys(ipcContract).sort();
const TIMER = { status: 'idle', mode: 'work', elapsedSeconds: 0, restoredFromPreviousLaunch: false } as const;

let contextCalls = 0;

function register(): () => void {
    contextCalls = 0;
    return registerIpcHandlers({
        context: () => {
            contextCalls += 1;
            // Only the two members the calls below reach; the rest of the container is not what this file checks.
            return { timer: { snapshot: () => TIMER }, companies: { list: () => [] } } as unknown as HandlerContext;
        },
        log: () => undefined
    });
}

const invoke = (channel: IpcChannel, input?: unknown): unknown => handlers.get(channel)?.({}, input);

describe('IPC-01: registration', () => {
    beforeEach(() => {
        removeIpcHandlers();
        handlers.clear();
        registrations.length = 0;
        removals.length = 0;
    });

    it('registers every contract channel exactly once, and nothing else', () => {
        register();
        expect([...registrations].sort()).toEqual(CONTRACT_CHANNELS);
        expect(registrations.length, 'a channel was registered twice').toBe(new Set(registrations).size);
        expect(registrations, 'S1: navigate is not a channel this app answers on').not.toContain('navigate');
    });

    /*
     * WR-06: it used to return the shared disposer as though it had registered, dropping the second caller's context
     * and log - so every channel kept resolving through the first caller's container, and the second caller's
     * disposer took the first caller's registration with it.
     */
    it('refuses a second registration rather than dropping its context on the floor', () => {
        register();
        const count = registrations.length;
        expect(() => register()).toThrow(/already registered/);
        expect(registrations.length, 'ipcMain was touched again by a call that was refused').toBe(count);
    });

    it('registers again once the channels have been taken off, which is what the smoke does', () => {
        const dispose = register();
        dispose();
        expect(() => register()).not.toThrow();
        expect([...registrations].sort()).toEqual([...CONTRACT_CHANNELS, ...CONTRACT_CHANNELS].sort());
    });

    it('removes every channel it registered, and removing twice is harmless', () => {
        const dispose = register();
        dispose();
        expect([...removals].sort()).toEqual(CONTRACT_CHANNELS);
        expect(handlers.size).toBe(0);
        removals.length = 0;
        dispose();
        expect(removals, 'a second removal touched ipcMain again').toEqual([]);
    });

    it('resolves the container once per call, not once per registration', async () => {
        register();
        expect(contextCalls, 'the container was resolved while registering, before the database may be open').toBe(0);
        await invoke('timer:getSnapshot');
        expect(contextCalls).toBe(1);
        await invoke('timer:getSnapshot');
        expect(contextCalls).toBe(2);
    });

    it('answers through the dispatcher: an IpcResult, and validation before the service', async () => {
        register();
        expect(await invoke('timer:getSnapshot')).toEqual({ ok: true, data: TIMER });

        const refused = await invoke('timer:setMode', { mode: 'sideways' }) as { ok: boolean; error?: { code: string } };
        expect(refused.ok).toBe(false);
        expect(refused.error?.code).toBe('INVALID_INPUT');
        expect(contextCalls, 'the container was reached for a payload the contract refuses').toBe(1);
    });

    it('passes the renderer\'s argument through and drops the IpcMainInvokeEvent', async () => {
        register();
        // The listener's first argument is Electron's event; nothing downstream may see it.
        const result: unknown = await handlers.get('companies:list')?.({ sender: 'the web contents' }, undefined);
        expect(result).toEqual({ ok: true, data: [] });
    });
});

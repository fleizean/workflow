// Criterion 10 and IPC-06: every subscription returns a disposer and forwards no event object, so React StrictMode's
// double mount leaks nothing. The bridge is built over a fake ipcRenderer - what is checked is the bridge, not Electron.

import { describe, expect, it } from 'vitest';
import { createIpcBridge } from '../src/preload/bridge';
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '../src/shared/ipc/channels';
import { ipcContract, ipcEvents } from '../src/shared/ipc/contract';
import { INTERNAL_ERROR_MESSAGE } from '../src/shared/constants/ipc-errors';
import type { EventForwarder, RendererIpc } from '../src/preload/bridge';

interface FakeIpc extends RendererIpc {
    readonly invocations: { channel: string; args: unknown[] }[];
    listeners(channel: string): EventForwarder[];
    /** Delivers as Electron does: the event object first, the payload second. */
    deliver(channel: string, payload: unknown): void;
    readonly totalListeners: number;
}

function fakeIpc(answer: unknown = { ok: true, data: null }): FakeIpc {
    const invocations: { channel: string; args: unknown[] }[] = [];
    const listeners = new Map<string, EventForwarder[]>();

    return {
        invocations,
        invoke: (channel, ...args) => {
            invocations.push({ channel, args });
            return Promise.resolve(answer);
        },
        on: (channel, listener) => {
            listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        },
        off: (channel, listener) => {
            listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== listener));
        },
        listeners: (channel) => listeners.get(channel) ?? [],
        deliver: (channel, payload) => {
            for (const listener of [...(listeners.get(channel) ?? [])]) {
                listener({ sender: 'the web contents', senderId: 1 }, payload);
            }
        },
        get totalListeners() {
            return [...listeners.values()].reduce((total, list) => total + list.length, 0);
        }
    };
}

const TICK = { status: 'running', mode: 'work', elapsedSeconds: 61, restoredFromPreviousLaunch: false } as const;

describe('IPC-01: the bridge is the contract', () => {
    it('exposes one method per channel, and the subscriptions under on', () => {
        const bridge = createIpcBridge(fakeIpc()) as unknown as Record<string, unknown>;
        const exposed = Object.keys(bridge).filter((key) => key !== 'on').sort();

        expect(exposed).toEqual(Object.keys(ipcContract).sort());
        expect(exposed, 'S1: navigate is not on the bridge').not.toContain('navigate');
        expect(Object.keys(bridge.on as object).sort()).toEqual(Object.keys(ipcEvents).sort());
        for (const channel of IPC_CHANNELS) {
            expect(typeof bridge[channel], channel + ' is not callable').toBe('function');
        }
    });

    it('is frozen, so a page cannot replace a channel with one of its own', () => {
        const bridge = createIpcBridge(fakeIpc()) as unknown as Record<string, unknown>;
        expect(Object.isFrozen(bridge)).toBe(true);
        expect(Object.isFrozen(bridge.on)).toBe(true);
    });

    it('passes the argument through and answers with whatever main sent back', async () => {
        const ipc = fakeIpc({ ok: true, data: [{ id: 1 }] });
        const bridge = createIpcBridge(ipc);

        await expect(bridge['companies:list']()).resolves.toEqual({ ok: true, data: [{ id: 1 }] });
        await bridge['companies:get']({ id: 7 });

        expect(ipc.invocations.map((call) => call.channel)).toEqual(['companies:list', 'companies:get']);
        expect(ipc.invocations[1]?.args).toEqual([{ id: 7 }]);
        // A void channel sends undefined, which is what z.void() accepts on the other side.
        expect(ipc.invocations[0]?.args).toEqual([undefined]);
    });
});

describe('criterion 10: every subscription returns a disposer and forwards no event object', () => {
    it.each([...IPC_EVENT_CHANNELS])('%s hands the listener the payload alone', (channel) => {
        const ipc = fakeIpc();
        const seen: unknown[] = [];
        const dispose = createIpcBridge(ipc).on[channel]((payload) => { seen.push(payload); });

        ipc.deliver(channel, TICK);
        expect(seen).toEqual([TICK]);
        expect(seen[0], 'the IpcRendererEvent reached the renderer').not.toHaveProperty('sender');
        expect(typeof dispose).toBe('function');
    });

    it('removes exactly the listener it added, and leaves the others subscribed', () => {
        const ipc = fakeIpc();
        const bridge = createIpcBridge(ipc);
        const first: unknown[] = [];
        const second: unknown[] = [];

        const disposeFirst = bridge.on['timer:tick']((p) => first.push(p));
        bridge.on['timer:tick']((p) => second.push(p));
        expect(ipc.listeners('timer:tick')).toHaveLength(2);

        disposeFirst();
        ipc.deliver('timer:tick', TICK);
        expect(first, 'a disposed subscription still received an event').toEqual([]);
        expect(second).toEqual([TICK]);
        expect(ipc.listeners('timer:tick')).toHaveLength(1);
    });

    // The StrictMode shape: mount, mount again, unmount both. What must be left behind is nothing.
    it('leaks nothing across a double mount and a double unmount', () => {
        const ipc = fakeIpc();
        const bridge = createIpcBridge(ipc);
        const received: unknown[] = [];
        const listener = (payload: unknown): void => { received.push(payload); };

        const disposeA = bridge.on['timer:tick'](listener);
        const disposeB = bridge.on['timer:tick'](listener);
        expect(ipc.totalListeners).toBe(2);

        disposeA();
        disposeB();
        expect(ipc.totalListeners, 'a subscription outlived its disposer').toBe(0);

        ipc.deliver('timer:tick', TICK);
        expect(received).toEqual([]);
    });

    it('is idempotent: disposing twice does not remove a later subscription', () => {
        const ipc = fakeIpc();
        const bridge = createIpcBridge(ipc);
        const listener = (): void => undefined;

        const dispose = bridge.on['timer:tick'](listener);
        dispose();
        dispose();
        bridge.on['timer:tick'](listener);
        dispose();

        expect(ipc.totalListeners, 'a second call to a spent disposer took someone else\'s subscription').toBe(1);
    });

    it('subscribes to one channel without touching another', () => {
        const ipc = fakeIpc();
        const bridge = createIpcBridge(ipc);
        const ticks: unknown[] = [];
        bridge.on['timer:tick']((p) => ticks.push(p));

        ipc.deliver('pomodoro:tick', { interval: 'work' });
        expect(ticks).toEqual([]);
        expect(ipc.listeners('pomodoro:tick')).toEqual([]);
    });
});

/*
 * WR-05 and WR-08: two ways a bridge can lie about what it guarantees. ApiOf says every call resolves to an
 * IpcResult and never rejects; IPC-06 says a subscription is one subscriber's, not a channel's.
 */
describe('the bridge keeps the promises its types make', () => {
    it('turns an invoke that rejects into the failure the renderer can render', async () => {
        const ipc = fakeIpc();
        const bridge = createIpcBridge({
            ...ipc,
            invoke: () => Promise.reject(new Error('An object could not be cloned.'))
        }) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;

        const answer = await bridge['sessions:list']?.();
        expect(answer, 'a rejected invoke reached a call site whose type says it cannot')
            .toEqual({ ok: false, error: { code: 'INTERNAL', message: INTERNAL_ERROR_MESSAGE } });
    });

    it('does the same for an argument structured clone cannot carry, which throws before it leaves', async () => {
        const ipc = fakeIpc();
        const bridge = createIpcBridge({
            ...ipc,
            invoke: () => { throw new Error('An object could not be cloned.'); }
        }) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;

        await expect(bridge['sessions:create']?.({ name: () => undefined })).resolves
            .toEqual({ ok: false, error: { code: 'INTERNAL', message: INTERNAL_ERROR_MESSAGE } });
    });
});

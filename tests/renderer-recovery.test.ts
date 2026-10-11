/*
 * The macOS lid-close freeze, as a regression test. This is the investigation's fullloop.repro.ts F1, promoted:
 * it is the one case that reproduced the owner's whole report, and the class of defect it pins is "main is fine,
 * the renderer stopped hearing, and nothing says so".
 *
 * Everything here is the real thing except Electron's transport: the real createTimerService over a controllable
 * scheduler and monotonic clock, the real createDispatch with the real ipcWrites, the real preload bridge shape,
 * the real lib/ipc facade, the real subscribeTimerTicks feed, the real Zustand store, the real createQueryClient
 * with a real active observer on the real timerSnapshotQuery, the real invalidateDomains, and the real mutation
 * options useTimerCommands hands to useMutation. The toggle is TimerPage's own branch, transcribed and guarded by
 * a source assertion that refuses to run if TimerPage stops reading that way.
 *
 * What the investigation measured, and what the cut models: after the render process dies, isCrashed() is true,
 * isDestroyed() is FALSE and webContents.send() does NOT throw. timer:tick and data:changed ride that one send, so
 * one break takes the display and every recovery path at once - and the app has no refetchOnWindowFocus and no
 * refetchInterval, so nothing else ever asks main what the clock says.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createDispatch } from '@main/ipc/dispatch';
import { createTimerService } from '@main/services/timer.service';
import type { PersistedTimerState, TimerService } from '@main/services/timer.service';
import type { ClockPort, RendererBusPort, SchedulerPort } from '@main/ports';
import { createQueryClient } from '@renderer/lib/query-client';
import { invalidateDomains } from '@renderer/lib/data-sync';
import { subscribeTimerTicks } from '@renderer/app/providers/timer-feed';
import { timerSnapshotQuery } from '@renderer/features/timer/api/useTimerSnapshot';
import {
    pauseTimerMutation, startTimerMutation
} from '@renderer/features/timer/api/useTimerCommands';
import { readTimerSnapshot, setTimerSnapshot } from '@renderer/features/timer/state/timer.store';
import { API_BRIDGE_KEY } from '@shared/constants/bridge';
import { ipcWrites } from '@shared/ipc/contract';
import type { DataDomain, IpcChannel, IpcHandlers, IpcResult, TimerSnapshot } from '@shared/types';
import { read } from './helpers/ts-imports';

const TICK_MS = 1000;
const EIGHT_HOURS_MS = 8 * 3_600_000;

interface Loop {
    readonly main: TimerService;
    /** Fires the scheduled tick `count` times, each `TICK_MS` of monotonic time later. */
    drive(count: number): void;
    /** Moves the monotonic source without firing anything: a frozen, throttled or sleeping process. */
    advance(ms: number): void;
    /** What the renderer would be showing: whatever the store was last told. */
    screen(): TimerSnapshot | null;
    /** The one press Home has, routed exactly as TimerPage routes it. */
    press(): Promise<void>;
    readonly logs: string[];
    /** Models the measured failure: send() goes nowhere and reports nothing. */
    cut(): void;
}

let client: QueryClient;
let disposers: (() => void)[] = [];

const IDLE: TimerSnapshot = {
    status: 'idle', mode: 'work', elapsedSeconds: 0, restoredFromPreviousLaunch: false, persistFailing: false
};

function buildLoop(): Loop {
    let mono = 50_000;
    const clock: ClockPort = { now: () => 1_757_000_000_000 + mono, monotonicNow: () => mono };

    let scheduled: (() => void) | undefined;
    const scheduler: SchedulerPort = {
        every: (_intervalMs, run) => {
            scheduled = run;
            return { cancel: () => { scheduled = undefined; } };
        },
        after: () => { throw new Error('the timer service schedules no one-shot delay'); }
    };

    const logs: string[] = [];
    const listeners = new Map<string, ((payload: unknown) => void)[]>();
    let delivering = true;

    /*
     * The renderer-bus adapter's job, with Electron's transport faked. `delivering = false` is a dead render
     * process: the window is not destroyed, send() does not throw, and nothing anywhere is told.
     */
    const bus: RendererBusPort = {
        emit: (channel, payload) => {
            if (!delivering) {
                return;
            }
            for (const listener of listeners.get(channel) ?? []) listener(payload);
        }
    };

    let persisted: PersistedTimerState = { accumulatedSeconds: 0, mode: 'work' };
    const main = createTimerService({
        clock,
        scheduler,
        bus,
        store: { read: () => persisted, write: (state) => { persisted = { ...persisted, ...state }; } },
        log: (line) => logs.push(line)
    });

    const handlers = {
        'timer:getSnapshot': () => main.snapshot(),
        'timer:start': () => main.start(),
        'timer:pause': () => main.pause()
    };

    const dispatch = createDispatch({
        handlers: () => handlers as unknown as IpcHandlers,
        // SPA-07, exactly as lifecycle.ts wires it: main announces the domains, the renderer invalidates them.
        announce: (domains: readonly DataDomain[]) => {
            bus.emit('data:changed', { domains: [...domains] });
        },
        log: (line) => logs.push(line)
    });

    const bridge: Record<string, unknown> = {};
    for (const channel of Object.keys(ipcWrites)) {
        bridge[channel] = (input?: unknown): Promise<IpcResult<unknown>> => dispatch(channel as IpcChannel, input);
    }
    bridge.on = Object.fromEntries(['timer:tick', 'data:changed'].map((channel) => [
        channel,
        (listener: (payload: unknown) => void) => {
            listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
            return () => {
                listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== listener));
            };
        }
    ]));
    (globalThis as unknown as Record<string, unknown>)[API_BRIDGE_KEY] = bridge;

    // app/providers: the tick feed, the DataSyncProvider invalidation, and an ACTIVE snapshot query whose every
    // result is written into the store (useTimerSnapshot's effect).
    disposers.push(subscribeTimerTicks(setTimerSnapshot));
    const sync = listeners.get('data:changed') ?? [];
    listeners.set('data:changed', [...sync, (payload) => {
        invalidateDomains(client, (payload as { domains: DataDomain[] }).domains);
    }]);

    const observer = new QueryObserver(client, { ...timerSnapshotQuery, networkMode: 'always', retry: false });
    disposers.push(observer.subscribe((result) => {
        if (result.data !== undefined) {
            setTimerSnapshot(result.data);
        }
    }));

    const mutate = async (options: typeof startTimerMutation): Promise<void> => {
        await new MutationObserver(client, options).mutate();
    };

    return {
        main,
        logs,
        advance: (ms) => { mono += ms; },
        drive(count) {
            for (let i = 0; i < count; i += 1) {
                mono += TICK_MS;
                scheduled?.();
            }
        },
        screen: () => readTimerSnapshot(),
        async press() {
            // TimerPage.toggleRunning, verbatim: the single button routes on what the SCREEN believes.
            const running = readTimerSnapshot()?.status === 'running';
            await mutate(running ? pauseTimerMutation : startTimerMutation);
            // The announce path is synchronous into invalidateQueries, whose refetch is not; let it land.
            await Promise.resolve();
            await client.getQueryCache().find({ queryKey: timerSnapshotQuery.queryKey })?.promise;
        },
        cut() { delivering = false; }
    };
}

beforeEach(() => {
    client = createQueryClient();
    disposers = [];
    setTimerSnapshot(IDLE);
});

afterEach(() => {
    for (const dispose of disposers) dispose();
    client.clear();
    delete (globalThis as unknown as Record<string, unknown>)[API_BRIDGE_KEY];
    setTimerSnapshot(IDLE);
});

describe('the guard: this suite is driving the toggle the Home screen actually has', () => {
    it('TimerPage still routes one button on the snapshot the store holds', () => {
        const source = read('src/renderer/src/features/timer/TimerPage.tsx');
        expect(source, 'the toggle no longer reads running off the store snapshot')
            .toContain("const running = snapshot?.status === 'running';");
        expect(source, 'toggleRunning no longer branches between pause and start').toContain(
            'const toggleRunning = (): void => {\r\n        if (running) {\r\n            pause.mutate();'
        );
    });
});

describe('F1: the renderer stops hearing main, and nothing says so', () => {
    it('freezes the display while main counts on, which is the owner report', async () => {
        const loop = buildLoop();
        await loop.press();
        loop.drive(10);
        expect(loop.screen()?.elapsedSeconds, 'the healthy case is not healthy').toBe(10);

        // The renderer is gone. Measured: the window is not destroyed, send() does not throw, nothing is logged.
        loop.cut();
        loop.drive(30);

        expect(loop.main.snapshot().elapsedSeconds, 'main stopped counting, which it never did').toBe(40);
        expect(loop.screen()?.elapsedSeconds, 'the display is supposed to be frozen in this case').toBe(10);
    });

    it('counts nothing for the sleep and comes back on one press, with the bus still cut', async () => {
        const loop = buildLoop();
        await loop.press();
        loop.drive(10);
        loop.cut();

        // The lid closes. powerMonitor suspend, eight hours of monotonic time, resume.
        loop.main.suspend();
        loop.advance(EIGHT_HOURS_MS);
        loop.main.resume();
        loop.drive(30);

        expect(loop.main.snapshot().elapsedSeconds, 'CORE-06: the sleep was credited as work').toBe(40);
        expect(loop.screen()?.elapsedSeconds, 'the display moved with no event able to reach it').toBe(10);

        /*
         * The press the owner made. Before this phase: it routed to pause() on a stale belief, silently stopped
         * main as well, and said nothing - so the screen stayed at 10 while the clock was dead. Now the command's
         * own answer is written into the store, so one press puts main's truth back on screen.
         */
        await loop.press();
        expect(loop.screen()?.status, 'the screen did not learn what main answered').toBe('paused');
        expect(loop.screen()?.elapsedSeconds, 'the frozen display survived a press').toBe(40);
    });

    it('keeps answering every press afterwards, instead of wedging the clock off', async () => {
        const loop = buildLoop();
        await loop.press();
        loop.drive(10);
        loop.cut();
        loop.drive(30);

        for (let i = 0; i < 6; i += 1) {
            await loop.press();
        }

        /*
         * Six presses from a running clock end running. Before this phase the first press paused main and presses
         * 2..6 were pause() on a paused timer - early-return, no emit - so the clock was left stopped and the
         * screen never moved: six presses, one state change, no feedback of any kind.
         */
        expect(loop.main.snapshot().status, 'the toggle left main stopped').toBe('running');
        expect(loop.screen()?.status, 'the screen disagrees with main after six presses').toBe('running');
        expect(loop.screen()?.elapsedSeconds).toBe(loop.main.snapshot().elapsedSeconds);

        // And it still counts: a recovered toggle that armed no repeat would be a clock that reads 'running'.
        const before = loop.main.snapshot().elapsedSeconds;
        loop.drive(5);
        expect(loop.main.snapshot().elapsedSeconds, 'the repeat was never re-armed').toBe(before + 5);
    });

    it('recovers the screen on a reload even with the tick stream lost, which is what the guard does', async () => {
        const loop = buildLoop();
        await loop.press();
        loop.drive(10);
        loop.cut();
        loop.drive(30);
        expect(loop.screen()?.elapsedSeconds).toBe(10);

        // reviveOnRendererLoss reloads the window; the remount re-reads timer:getSnapshot through the live bridge.
        const fresh = await client.fetchQuery(timerSnapshotQuery);
        setTimerSnapshot(fresh);
        expect(loop.screen()?.elapsedSeconds, 'a reloaded renderer did not resync from main').toBe(40);
    });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { invalidateDomains } from '@renderer/lib/data-sync';
import { createQueryClient } from '@renderer/lib/query-client';
import { IpcCallError, invoke, subscribe } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import { companiesQuery } from '@renderer/features/companies/api/useCompanies';
import { sessionsQuery } from '@renderer/features/history/api/useSessions';
import { weekTotalsQuery } from '@renderer/features/history/api/useWeekTotals';
import { companySessionsQuery } from '@renderer/features/companies/api/useCompanySessions';
import { settingsQuery } from '@renderer/features/settings/api/useSettings';
import { timerSnapshotQuery } from '@renderer/features/timer/api/useTimerSnapshot';
import { timerSessionsQuery } from '@renderer/features/timer/api/useTimerSessions';
import { streakQuery } from '@renderer/features/timer/api/useStreak';
import { pomodoroCountsQuery, pomodoroSnapshotQuery } from '@renderer/features/timer/api/usePomodoro';
import { useUiStore } from '@renderer/store/ui.store';
import { API_BRIDGE_KEY } from '@shared/constants/bridge';
import { DATA_DOMAINS, ipcWrites } from '@shared/ipc/contract';
import { createDispatch } from '@main/ipc/dispatch';
import { formatLocalDate } from '@shared/utils/date';
import type { DataDomain, IpcChannel, IpcHandlers, IpcResult } from '@shared/types';

/*
 * Criterion 4, executed rather than reviewed.
 *
 * The failure this file exists for is quiet and total. The preload bridge RESOLVES an { ok: false, error }
 * envelope - it never rejects, which is right for a wire format and wrong for a caller. Hand that straight to
 * TanStack Query and Query sees a successful result whose data happens to be an error object: isError is false
 * forever, every error branch in the UI is dead code, and a failed call renders as an empty list. Nothing about
 * that is visible to typecheck or to lint. So this runs the real thing: a real dispatch over a handler that fails,
 * through the real bridge shape, into the real query objects the hooks pass to useQuery.
 *
 * What it does NOT prove: that a React component renders the error state - there is no jsdom here, so the last
 * step is asserted by reading the hook. That is why the query objects are exported: the thing executed here is the
 * same object the hook passes in, not a copy written for the test.
 */

const FAILING_CHANNEL = 'sessions:list';
const SOME_DAY = formatLocalDate(new Date(2026, 8, 13));

const EVENT_CHANNELS = ['app:playSound', 'timer:tick', 'pomodoro:tick', 'data:changed'];

type BridgeCall = () => Promise<IpcResult<unknown>>;

/** Who is listening to each main-to-renderer event. */
const listeners = new Map<string, ((payload: unknown) => void)[]>();
/** Every set of domains dispatch announced, in order. */
let announced: (readonly DataDomain[])[] = [];

/**
 * The preload bridge, built the way the real one is: one method per channel resolving an IpcResult, plus `on`.
 * It is handed the real main-side dispatch, so a failing handler produces the real { ok: false } envelope with the
 * real error code rather than a hand-written one.
 */
function installBridge(handlers: Partial<IpcHandlers>): void {
    const dispatch = createDispatch({
        handlers: () => handlers as IpcHandlers,
        announce: (domains) => { announced.push(domains); },
        log: () => undefined
    });

    const bridge: Record<string, unknown> = {};
    for (const channel of Object.keys(ipcWrites)) {
        bridge[channel] = (input?: unknown): Promise<IpcResult<unknown>> =>
            dispatch(channel as IpcChannel, input);
    }
    bridge.on = Object.fromEntries(EVENT_CHANNELS.map((channel) => [
        channel,
        (listener: (payload: unknown) => void) => {
            listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
            return () => {
                listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== listener));
            };
        }
    ]));
    (globalThis as unknown as Record<string, unknown>)[API_BRIDGE_KEY] = bridge;
    (globalThis as unknown as { window?: unknown }).window = globalThis;
}

/** Main pushing an event, exactly as the renderer-bus adapter does: whatever is listening, gets it. */
const emit = (channel: string, payload: unknown): void => {
    for (const listener of listeners.get(channel) ?? []) {
        listener(payload);
    }
};

let client: QueryClient;

beforeEach(() => {
    listeners.clear();
    announced = [];
    client = createQueryClient();
});

afterEach(() => {
    client.clear();
    delete (globalThis as unknown as Record<string, unknown>)[API_BRIDGE_KEY];
});

describe('SPA-05: a failed IPC call rejects, so the query has an error state at all', () => {
    it('turns a handler that throws into a rejected promise, not a resolved envelope', async () => {
        installBridge({
            [FAILING_CHANNEL]: () => { throw new Error('the database is not open'); }
        });

        // What the bridge itself answers: a resolved envelope. This is the shape the facade exists to unwrap.
        const installed = (globalThis as unknown as Record<string, Record<string, BridgeCall>>)[API_BRIDGE_KEY];
        const raw = await installed?.[FAILING_CHANNEL]?.();
        expect(raw?.ok, 'the bridge is supposed to resolve a failure, not reject it').toBe(false);

        await expect(invoke(FAILING_CHANNEL)).rejects.toBeInstanceOf(IpcCallError);
    });

    it('ends the query the UI reads in an error state, with the error the call failed with', async () => {
        installBridge({
            [FAILING_CHANNEL]: () => { throw new Error('the database is not open'); }
        });

        await expect(client.fetchQuery(sessionsQuery)).rejects.toBeInstanceOf(IpcCallError);

        const state = client.getQueryState(queryKeys.sessions);
        expect(state?.status, 'the query resolved, so no screen would ever render an error').toBe('error');
        expect(state?.error).toBeInstanceOf(IpcCallError);
        expect((state?.error as IpcCallError).channel).toBe(FAILING_CHANNEL);
        expect(state?.data, 'a failed call must leave no data behind to render as an empty list').toBeUndefined();
    });

    it('raises a toast from the cache, so a screen that forgets its error branch still says something', async () => {
        installBridge({
            [FAILING_CHANNEL]: () => { throw new Error('the database is not open'); }
        });
        const { useUiStore } = await import('@renderer/store/ui.store');
        useUiStore.setState({ toasts: [] });

        await client.fetchQuery(sessionsQuery).catch(() => undefined);

        const toasts = useUiStore.getState().toasts;
        expect(toasts.length, 'the QueryCache onError did not fire').toBe(1);
        expect(toasts[0]?.tone).toBe('error');
    });

    it('still resolves data when the handler succeeds, so the unwrap is not just a thrower', async () => {
        installBridge({ 'companies:list': () => [] });
        await expect(client.fetchQuery(companiesQuery)).resolves.toEqual([]);
        expect(client.getQueryState(queryKeys.companies)?.status).toBe('success');
    });
});

describe('SPA-06: queries run whatever the browser says about the network', () => {
    it('defaults every query and mutation to networkMode always', () => {
        const defaults = client.getDefaultOptions();
        expect(
            defaults.queries?.networkMode,
            "TanStack's default is 'online', which PAUSES a query when navigator.onLine is false. This app is " +
            'offline by design over a database on the same disk, so that default is a permanent spinner.'
        ).toBe('always');
        expect(defaults.mutations?.networkMode).toBe('always');
    });

    /*
     * onlineManager is the thing TanStack actually consults - the browser's online/offline events feed it, and it
     * is what a paused query is waiting on. Setting it directly is the same state a laptop with the Wi-Fi off
     * puts the app in, without needing a browser to be off a network.
     */
    it('fetches while TanStack reports the app offline, and would not under the default', async () => {
        installBridge({ 'settings:get': () => ({ target: 1 }) } as unknown as Partial<IpcHandlers>);
        onlineManager.setOnline(false);
        try {
            await client.fetchQuery(settingsQuery);
            expect(client.getQueryState(queryKeys.settings)?.status, 'the query paused instead of running')
                .toBe('success');

            // The control: the same call under TanStack's own default never leaves the gate.
            const paused = ['paused-control'];
            void client.prefetchQuery({
                queryKey: paused,
                queryFn: () => invoke('settings:get'),
                networkMode: 'online'
            });
            await Promise.resolve();
            expect(
                client.getQueryState(paused)?.fetchStatus,
                "networkMode 'online' did not pause, so this control proves nothing about what the default costs"
            ).toBe('paused');
        } finally {
            onlineManager.setOnline(true);
        }
    });
});

describe('SPA-07: a change made in main refreshes the views that show it', () => {
    /** Puts a resolved value in the cache and reports how many times the queryFn ran. */
    const seed = async (options: { queryKey: readonly unknown[] }, run: () => number): Promise<void> => {
        await client.fetchQuery({ queryKey: options.queryKey, queryFn: () => Promise.resolve(run()) });
    };

    it('invalidates by domain prefix, so one announcement refreshes every key in it', async () => {
        installBridge({});

        let runs = 0;
        await seed({ queryKey: queryKeys.sessions }, () => ++runs);
        await seed({ queryKey: queryKeys.timerSnapshot }, () => ++runs);
        expect(runs).toBe(2);

        // Exactly what DataSyncProvider composes: the facade's subscription, and the module it hands the payload to.
        const dispose = subscribe('data:changed', (payload) => { invalidateDomains(client, payload.domains); });
        emit('data:changed', { domains: ['sessions'] });

        expect(client.getQueryState(queryKeys.sessions)?.isInvalidated, 'the sessions cache was not invalidated')
            .toBe(true);
        expect(
            client.getQueryState(queryKeys.timerSnapshot)?.isInvalidated,
            'an unrelated domain was invalidated too, which refetches the whole app on every write'
        ).toBe(false);

        // ['timer'] is a prefix of ['timer', 'snapshot'], which is the point of keying by domain.
        emit('data:changed', { domains: ['timer'] });
        expect(client.getQueryState(queryKeys.timerSnapshot)?.isInvalidated).toBe(true);

        dispose();
        expect(listeners.get('data:changed')?.length, 'the disposer left the subscription in place').toBe(0);
    });

    it('announces from dispatch after a write, and says nothing after a read', async () => {
        installBridge({
            'sessions:create': () => ({ id: 1 }),
            'sessions:list': () => []
        } as unknown as Partial<IpcHandlers>);

        await invoke('sessions:list');
        expect(announced, 'a read announced a change, which would refetch on every read').toEqual([]);

        await invoke('sessions:create', {
            name: 'x', durationSeconds: 60, date: SOME_DAY, companyId: null, note: null
        });
        expect(announced).toEqual([ipcWrites['sessions:create']]);
    });

    it('does not announce a write that failed', async () => {
        installBridge({
            'sessions:create': () => { throw new Error('disk full'); }
        });

        await invoke('sessions:create', {
            name: 'x', durationSeconds: 60, date: SOME_DAY, companyId: null, note: null
        }).catch(() => undefined);
        expect(announced, 'a failed write announced a change that never happened').toEqual([]);
    });

    it('keeps the call successful when the announcement throws', async () => {
        const dispatch = createDispatch({
            handlers: () => ({ 'settings:update': () => ({ ok: true }) }) as unknown as IpcHandlers,
            announce: () => { throw new Error('no window to tell'); },
            log: () => undefined
        });
        const result = await dispatch('settings:update', {});
        expect(
            result.ok,
            'the write landed; failing the call over an undelivered event would make the renderer re-ask for ' +
            'something that already happened'
        ).toBe(true);
    });

    /*
     * WR-07. checked() runs the contract's output schema whenever checkOutput is on, which register.ts sets for
     * every electron-vite dev run. It ran BEFORE the announcement, so a write that had committed but answered
     * something the contract does not describe fell into the catch: { ok: false }, no announcement, an error on
     * screen - and the row on disk. Under npm run dev that trains the developer that the write failed.
     */
    it('announces a write that committed even when its answer fails the output check', async () => {
        const dispatch = createDispatch({
            handlers: () => ({ 'sessions:create': () => ({ id: 'not-a-number' }) }) as unknown as IpcHandlers,
            announce: (domains) => { announced.push(domains); },
            log: () => undefined,
            checkOutput: true
        });

        const result = await dispatch('sessions:create', {
            name: 'x', durationSeconds: 60, date: SOME_DAY, companyId: null, note: null
        });

        expect(result.ok, 'an answer the contract does not describe is still a bug in main').toBe(false);
        expect(
            announced,
            'the row is on disk and nothing was told about it, so the renderer shows an error over a write that ' +
            'landed and never refetches'
        ).toEqual([ipcWrites['sessions:create']]);
    });

    /*
     * WR-05. The file's header says a failed call is surfaced once, from one place. Only a QueryCache was
     * supplied, so a failed MUTATION raised nothing at all - and the mutations are sessions:create,
     * sessions:update and timer:stopAndSave, which is the Core Value path.
     */
    it('raises a failed write from the cache, not only a failed read', async () => {
        installBridge({ 'sessions:create': () => { throw new Error('disk full'); } });
        const before = useUiStore.getState().toasts.length;

        await client.getMutationCache().build(client, {
            mutationFn: () => invoke('sessions:create', {
                name: 'x', durationSeconds: 60, date: SOME_DAY, companyId: null, note: null
            })
        }).execute(undefined).catch(() => undefined);

        const raised = useUiStore.getState().toasts.slice(before);
        expect(raised.length, 'a failed write raised nothing, from anywhere').toBeGreaterThan(0);
        expect(raised.map((toast) => toast.tone)).toContain('error');
        // The handler's own reason stays in main's log (T-01-37); what crosses is the contract's message.
        expect(raised.map((toast) => toast.message).join(' ')).toContain('was not completed');
    });

    it('keys every query the features export by one of the declared keys', () => {
        const declared = Object.values(queryKeys).map((key) => JSON.stringify(key));
        const all = [
            companiesQuery, sessionsQuery, settingsQuery, timerSnapshotQuery, weekTotalsQuery, companySessionsQuery,
            timerSessionsQuery, streakQuery, pomodoroSnapshotQuery, pomodoroCountsQuery
        ];
        for (const query of all) {
            expect(declared, 'a feature keyed a query outside lib/query-keys.ts, where nothing can find it to invalidate')
                .toContain(JSON.stringify(query.queryKey));
        }
    });

    /*
     * Companies reads the session list through its own api file rather than through features/history, because an
     * index.ts carries its feature's page with it and the two screens need each other's data. That is only
     * acceptable while the two objects are the SAME cache entry - otherwise the app fetches the list twice and one
     * copy goes stale behind the other.
     */
    it('reads the session list from one cache entry, whichever feature asked for it', () => {
        expect(JSON.stringify(companySessionsQuery.queryKey)).toBe(JSON.stringify(sessionsQuery.queryKey));
        expect(JSON.stringify(timerSessionsQuery.queryKey)).toBe(JSON.stringify(sessionsQuery.queryKey));
    });

    it('keys every query by a domain main can announce', () => {
        const offenders = Object.entries(queryKeys)
            .filter(([, key]) => !(DATA_DOMAINS as readonly string[]).includes(String(key[0])));
        expect(
            offenders.map(([name]) => name),
            'a query keyed outside the domain vocabulary is a cache nothing in main can ever refresh (SPA-07)'
        ).toEqual([]);
    });
});

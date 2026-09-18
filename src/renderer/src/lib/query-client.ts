/*
 * The one QueryClient. Two settings here are decisions rather than defaults.
 *
 * networkMode 'always' - the app is offline by design (SPA-06). TanStack's default pauses a query when its
 * onlineManager reports no connection, so a laptop with the Wi-Fi off would spin forever over a local database.
 *
 * The cache-level onError - a failed call is surfaced once, from one place. WR-05: both caches. Only the query one
 * existed, so a failed WRITE raised nothing at all - and the writes are sessions:create, sessions:update and
 * timer:stopAndSave, which is the Core Value path.
 *
 * A plain module rather than part of QueryProvider.tsx, so the client a test builds is the client the app runs.
 */

import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { useUiStore } from '@renderer/store/ui.store';

function describe(error: unknown): string {
    return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.';
}

export function createQueryClient(): QueryClient {
    return new QueryClient({
        queryCache: new QueryCache({
            onError: (error) => { useUiStore.getState().pushToast('error', describe(error)); }
        }),
        mutationCache: new MutationCache({
            onError: (error) => { useUiStore.getState().pushToast('error', describe(error)); }
        }),
        defaultOptions: {
            queries: {
                networkMode: 'always',
                retry: false,
                refetchOnWindowFocus: false
            },
            mutations: { networkMode: 'always' }
        }
    });
}

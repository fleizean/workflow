/*
 * The one QueryClient. Two settings here are decisions rather than defaults:
 *
 * networkMode 'always' - the app is offline by design (SPA-06). TanStack's default pauses a query when its
 * onlineManager reports no connection, and a desktop app on a laptop with the Wi-Fi off would then show a spinner
 * forever over a database sitting on the same disk.
 *
 * The cache-level onError - a failed call is surfaced once, from one place, rather than by each screen remembering
 * to. Query errors still reach the screen as well; this is the part that is visible even if the screen forgets.
 * WR-05: both caches. Only the query one existed, so a failed WRITE raised nothing at all - and the writes are
 * sessions:create, sessions:update and timer:stopAndSave, which is the Core Value path.
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

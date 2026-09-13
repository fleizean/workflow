/*
 * The one QueryClient. Two settings here are decisions rather than defaults:
 *
 * networkMode 'always' - the app is offline by design (SPA-06). TanStack's default pauses a query when the browser
 * reports no connection, and a desktop app on a laptop with the Wi-Fi off would then show a spinner forever over a
 * database sitting on the same disk.
 *
 * The cache-level onError - a failed call is surfaced once, from one place, rather than by each screen remembering
 * to. Query errors still reach the screen as well; this is the part that is visible even if the screen forgets.
 */

import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useUiStore } from '@renderer/store/ui.store';

function describe(error: unknown): string {
    return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.';
}

export function createQueryClient(): QueryClient {
    return new QueryClient({
        queryCache: new QueryCache({
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

export function QueryProvider({ children }: { children: ReactNode }): ReactElement {
    // useState, not a module constant: a client created at import time outlives a hot reload and keeps a stale cache.
    const [client] = useState(createQueryClient);
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

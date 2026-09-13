/*
 * SPA-07: a change made in main refreshes the views that show it.
 *
 * Main announces domains, never rows, so the renderer refetches over the same channels it reads with and there is
 * no second, quieter way for data to enter the cache. Two kinds of change arrive here: a write the renderer asked
 * for - dispatch announces it after the handler returns, so a create in one feature refreshes another feature's
 * list without either knowing about the other - and a write nobody asked for, which is a pomodoro interval
 * completing on main's own scheduler and writing a session row with no call behind it.
 *
 * A provider rather than a hook a screen calls: ARCH-03 puts the bridge in features/[domain]/api and app/providers
 * only, and a subscription owned by a screen would stop the moment that screen unmounted.
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { invalidateDomains } from '@renderer/lib/data-sync';
import { subscribe } from '@renderer/lib/ipc';

export function DataSyncProvider({ children }: { children: ReactNode }): ReactElement {
    const client = useQueryClient();

    useEffect(
        () => subscribe('data:changed', (payload) => { invalidateDomains(client, payload.domains); }),
        [client]
    );

    return <>{children}</>;
}

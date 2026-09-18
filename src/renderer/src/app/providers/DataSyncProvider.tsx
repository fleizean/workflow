/*
 * SPA-07: a change made in main refreshes the views that show it.
 *
 * Main announces domains, never rows, so the renderer refetches over the same channels it reads with. Two kinds of
 * change arrive: a write the renderer asked for - dispatch announces it after the handler returns, so a create in
 * one feature refreshes another's list - and a write nobody asked for, which is a pomodoro interval completing on
 * main's own scheduler.
 *
 * A provider rather than a hook a screen calls: a subscription owned by a screen would stop when it unmounted.
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

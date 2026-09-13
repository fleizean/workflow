/*
 * SPA-07: what a `data:changed` event does to the cache, as a plain function.
 *
 * It lives here rather than inside DataSyncProvider because a rule this load-bearing should be run by a test
 * rather than read by a reviewer, and there is no jsdom in this project to render the provider in. The provider
 * subscribes; this is the whole of what it does with what arrives.
 */

import type { QueryClient } from '@tanstack/react-query';
import { queryKeyForDomain } from '@renderer/lib/query-keys';
import type { DataDomain } from '@shared/types';

export function invalidateDomains(client: QueryClient, domains: readonly DataDomain[]): void {
    for (const domain of domains) {
        // Every key in a domain starts with the domain, so this is a prefix match rather than an exact one.
        void client.invalidateQueries({ queryKey: queryKeyForDomain(domain) });
    }
}

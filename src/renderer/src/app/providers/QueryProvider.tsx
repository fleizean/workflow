// The provider around the one client. Everything that decides how queries behave is in lib/query-client.ts.

import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createQueryClient } from '@renderer/lib/query-client';

export function QueryProvider({ children }: { children: ReactNode }): ReactElement {
    // useState, not a module constant: a client created at import time outlives a hot reload and keeps a stale cache.
    const [client] = useState(createQueryClient);
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

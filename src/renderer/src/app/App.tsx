/*
 * The composition root: providers outside, the route table inside.
 *
 * HashRouter, deliberately. The renderer is loaded from a file URL (out/renderer/index.html inside the packaged
 * app) and there is no server underneath it to rewrite paths. A history-API router would push /companies onto the
 * address bar, and the first reload would ask the file system for a file called companies next to index.html -
 * which does not exist, so the window goes blank. With a hash route the document is always index.html and the
 * route lives after the #, which a reload preserves.
 */

import type { ReactElement } from 'react';
import { HashRouter } from 'react-router-dom';
import { DataSyncProvider, QueryProvider, SoundProvider } from './providers';
import AppRoutes from './router';

export default function App(): ReactElement {
    return (
        <QueryProvider>
            <DataSyncProvider>
                <SoundProvider>
                    <HashRouter>
                        <AppRoutes />
                    </HashRouter>
                </SoundProvider>
            </DataSyncProvider>
        </QueryProvider>
    );
}

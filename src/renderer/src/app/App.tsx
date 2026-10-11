/*
 * The composition root: providers outside, the route table inside.
 *
 * HashRouter, deliberately. The renderer is loaded from a file URL and there is no server underneath it to rewrite
 * paths, so a history-API router would push /companies onto the address bar and the first reload would ask the
 * file system for a file called companies next to index.html - which does not exist, so the window goes blank.
 */

import type { ReactElement } from 'react';
import { HashRouter } from 'react-router-dom';
import { DataSyncProvider, QueryProvider, SaveRequestProvider, SoundProvider, TimerProvider } from './providers';
import AppRoutes from './router';

export default function App(): ReactElement {
    return (
        <QueryProvider>
            <DataSyncProvider>
                <TimerProvider>
                    <SaveRequestProvider>
                        <SoundProvider>
                            <HashRouter>
                                <AppRoutes />
                            </HashRouter>
                        </SoundProvider>
                    </SaveRequestProvider>
                </TimerProvider>
            </DataSyncProvider>
        </QueryProvider>
    );
}

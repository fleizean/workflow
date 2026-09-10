/*
 * src/renderer/src/App.tsx - the routing root.
 *
 * HashRouter, deliberately. The renderer is loaded from a file URL (out/renderer/index.html inside
 * the packaged app), and there is no server underneath it to rewrite paths. A history-API router
 * would push /companies onto the address bar, and the first reload would then ask the file system
 * for a file called companies next to index.html - which does not exist, so the window goes blank.
 * With a hash route the document is always index.html and the route lives after the #, which a
 * reload preserves. This is also what replaces v1.2.1's navigation model, where the main process
 * loadFile()'d a different HTML page per screen: there is one document now, and it never changes.
 *
 * The route table is static and literal. An unknown hash falls back to Home rather than rendering
 * an empty outlet, because a blank content area is the exact failure this shell exists to rule out.
 * AppShell wraps every route, so the shell and the bottom navigation render once, not per route.
 */

import type { ReactElement } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import CompaniesRoute from './routes/Companies';
import HistoryRoute from './routes/History';
import HomeRoute from './routes/Home';
import SettingsRoute from './routes/Settings';

export default function App(): ReactElement {
    return (
        <HashRouter>
            <Routes>
                <Route element={<AppShell />}>
                    <Route index element={<HomeRoute />} />
                    <Route path="companies" element={<CompaniesRoute />} />
                    <Route path="history" element={<HistoryRoute />} />
                    <Route path="settings" element={<SettingsRoute />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
            </Routes>
        </HashRouter>
    );
}

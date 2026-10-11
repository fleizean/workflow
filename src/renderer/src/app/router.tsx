/*
 * The only route table (ARCH-02). v1.2.1 changed screens by asking main to loadFile() a different HTML document;
 * there is one document now, so a screen change is this table picking an element. An unknown hash falls back to
 * Home rather than rendering an empty outlet: a blank content area is what this shell exists to rule out.
 */

import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from '@renderer/components/layout/AppShell';
import { CompaniesPage } from '@renderer/features/companies';
import { HistoryPage } from '@renderer/features/history';
import { PanelPage } from '@renderer/features/panel';
import { SettingsPage } from '@renderer/features/settings';
import { TimerPage } from '@renderer/features/timer';
import { ROUTE_PATHS } from '@renderer/lib/routes';

export default function AppRoutes(): ReactElement {
    return (
        <Routes>
            {/*
              * PANEL-05: outside AppShell, deliberately. The panel is its own window - a titlebar, a bottom
              * navigation and a 40rem column inside a 320px panel would each be wrong, and the shell's h-screen
              * would fight the panel's. Declared before the shell so its catch-all cannot swallow this route.
              */}
            <Route path={ROUTE_PATHS.panel} element={<PanelPage />} />
            <Route element={<AppShell />}>
                <Route index element={<TimerPage />} />
                <Route path={ROUTE_PATHS.companies} element={<CompaniesPage />} />
                <Route path={ROUTE_PATHS.history} element={<HistoryPage />} />
                <Route path={ROUTE_PATHS.settings} element={<SettingsPage />} />
                <Route path="*" element={<Navigate to={ROUTE_PATHS.home} replace />} />
            </Route>
        </Routes>
    );
}

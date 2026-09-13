/*
 * The only route table (ARCH-02). v1.2.1 changed screens by asking the main process to loadFile() a different HTML
 * document; there is one document now and it never changes, so a screen change is this table picking an element.
 *
 * An unknown hash falls back to Home rather than rendering an empty outlet: a blank content area is the exact
 * failure this shell exists to rule out. AppShell wraps every route, so the chrome renders once, not per route.
 */

import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from '@renderer/components/layout/AppShell';
import { CompaniesPage } from '@renderer/features/companies';
import { HistoryPage } from '@renderer/features/history';
import { SettingsPage } from '@renderer/features/settings';
import { TimerPage } from '@renderer/features/timer';
import { ROUTE_PATHS } from '@renderer/lib/routes';

export default function AppRoutes(): ReactElement {
    return (
        <Routes>
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

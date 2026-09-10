/*
 * src/renderer/src/components/layout/AppShell.tsx - the chrome every route renders inside.
 *
 * The container carries the app-container class string every v1.2.1 page used, plus the colour and
 * font classes v1.2.1 put on <body>: src/renderer/index.html's body is left bare, so the shell is
 * where the dark background and the light text now live.
 *
 * KNOWN DEFECT, LEFT AS IT IS ON PURPOSE: this container is max-w-md (448 px) while the bottom
 * navigation caps itself at 430 px, so above the md breakpoint the two do not line up. That
 * mismatch is inherited verbatim from v1.2.1. Its fix is one shared width token, which belongs to
 * Phase 7, and the behaviour at every window size is Phase 9's responsive sweep. Inventing a width
 * here would fix it twice, against a target that has not been ported yet.
 */

import type { ReactElement } from 'react';
import { Outlet } from 'react-router-dom';
import BottomNav from './BottomNav';

export default function AppShell(): ReactElement {
    return (
        <div className="app-container relative flex h-screen w-full flex-col overflow-hidden max-w-md mx-auto shadow-2xl font-display bg-background-light dark:bg-background-dark text-slate-900 dark:text-white">
            <main className="flex-1 overflow-y-auto">
                <Outlet />
            </main>
            <BottomNav />
        </div>
    );
}

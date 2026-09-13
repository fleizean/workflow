/*
 * The chrome every route renders inside: titlebar, the scrolling content area, the bottom navigation and the toast
 * stack. v1.2.1 rebuilt all of it on every page load; here it mounts once and the route changes underneath it.
 *
 * AlertDialog is mounted here, once: it draws whatever useUiStore.openDialog was last asked for, so a screen
 * asks a question by calling the store rather than by building an overlay of its own (criterion 5).
 *
 * The colour and font classes are the ones v1.2.1 put on <body>. src/renderer/index.html's body is left bare, so
 * the shell is where the dark background and the light text live.
 *
 * The scrollbar-hiding utilities replace legacy/styles/common.css's global ::-webkit-scrollbar rule, scoped to the
 * one element that actually scrolls (ARCH-05: no second stylesheet).
 *
 * KNOWN DEFECT, LEFT AS IT IS ON PURPOSE: this container is max-w-md (448 px) while the bottom navigation caps
 * itself at 430 px, so above the md breakpoint the two do not line up. That mismatch is inherited verbatim from
 * v1.2.1; SPA-02 closes it with one shared width token, and Phase 10 does the responsive sweep.
 */

import type { ReactElement } from 'react';
import { Outlet } from 'react-router-dom';
import AlertDialog from '@renderer/components/ui/AlertDialog';
import ToastStack from '@renderer/components/ui/ToastStack';
import { TitleBar } from '@renderer/features/shell';
import BottomNav from './BottomNav';

const SHELL_CLASS =
    'relative flex h-screen w-full flex-col overflow-hidden max-w-md mx-auto shadow-2xl font-display ' +
    'bg-background-light dark:bg-background-dark text-slate-900 dark:text-white';

const CONTENT_CLASS = 'flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

export default function AppShell(): ReactElement {
    return (
        <div className={SHELL_CLASS}>
            <TitleBar />
            <main className={CONTENT_CLASS}>
                <Outlet />
            </main>
            <BottomNav />
            <ToastStack />
            <AlertDialog />
        </div>
    );
}

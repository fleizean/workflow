/*
 * The bottom navigation, ported from legacy/renderer/bottom-nav.js. Carried over verbatim as content: the four
 * items, their icons and order, the class strings for both states, the "Go to <label>" accessible name, aria-current
 * and the filled icon on the active item, and the style block the imperative version injected for #bottomNav, as
 * utility classes instead of a <style> element. What goes: the href column and the click handler - each item is a
 * NavLink to a path in lib/routes.ts, and the active state comes from NavLink's isActive.
 *
 * Each state's classes are written out in full rather than joined at render time: a class name that only exists
 * after a concatenation is one Tailwind's scanner never saw, and it emits no CSS for it (C3).
 *
 * v1.2.1 capped this bar at 430 px while the shell above it was 448 px; both are max-w-app now (SPA-02). The bar
 * tracks the content column at EVERY width, not only above md - it used to centre at md and span the whole window
 * below it, so between 448 px and 768 px a 448 px column sat above an edge-to-edge bar. The rounded top starts at
 * sm (40rem), which is where the bar stops spanning the window (Phase 10 criterion 1).
 */

import type { ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import { ROUTE_PATHS } from '@renderer/lib/routes';

interface NavItem {
    readonly to: string;
    readonly icon: string;
    readonly label: string;
}

const NAV_ITEMS: readonly NavItem[] = [
    { to: ROUTE_PATHS.home, icon: 'home', label: 'Home' },
    { to: ROUTE_PATHS.companies, icon: 'business', label: 'Companies' },
    { to: ROUTE_PATHS.history, icon: 'history', label: 'History' },
    { to: ROUTE_PATHS.settings, icon: 'settings', label: 'Settings' }
];

const NAV_CLASS =
    'fixed bottom-0 left-0 right-0 z-50 max-w-app mx-auto bg-white dark:bg-surface-dark border-t border-slate-200 dark:border-slate-800 ' +
    'shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1),0_-2px_4px_-1px_rgba(0,0,0,0.06)] ' +
    'sm:rounded-t-[24px]';

const LINK_CLASS: Record<'active' | 'inactive', string> = {
    active: 'flex items-end justify-center text-center mx-auto px-4 pt-2 w-full transition-colors duration-200 text-primary',
    inactive: 'flex items-end justify-center text-center mx-auto px-4 pt-2 w-full transition-colors duration-200 text-gray-400 group-hover:text-primary'
};

const INDICATOR_CLASS: Record<'active' | 'inactive', string> = {
    active: 'block w-5 mx-auto h-1 rounded-full transition-all duration-200 bg-primary',
    inactive: 'block w-5 mx-auto h-1 rounded-full transition-all duration-200 bg-transparent group-hover:bg-primary'
};

// The FILL axis of the variable icon font, which is what draws the active tab's icon solid rather than outlined.
const ICON_CLASS: Record<'active' | 'inactive', string> = {
    active: "material-symbols-outlined text-2xl pt-1 mb-1 block [font-variation-settings:'FILL'_1,'wght'_400,'GRAD'_0,'opsz'_24]",
    inactive: 'material-symbols-outlined text-2xl pt-1 mb-1 block'
};

const stateOf = (isActive: boolean): 'active' | 'inactive' => (isActive ? 'active' : 'inactive');

export default function BottomNav(): ReactElement {
    return (
        <nav className={NAV_CLASS}>
            <div className="max-w-app mx-auto px-7">
                <div className="flex">
                    {NAV_ITEMS.map((item) => (
                        <div key={item.to} className="flex-1 group">
                            <NavLink
                                to={item.to}
                                end
                                aria-label={'Go to ' + item.label}
                                aria-current="page"
                                className={({ isActive }) => LINK_CLASS[stateOf(isActive)]}
                            >
                                {({ isActive }) => (
                                    <span className="block px-1 pt-1 pb-1">
                                        <span className={ICON_CLASS[stateOf(isActive)]}>{item.icon}</span>
                                        <span className="block text-xs pb-2">{item.label}</span>
                                        <span className={INDICATOR_CLASS[stateOf(isActive)]} />
                                    </span>
                                )}
                            </NavLink>
                        </div>
                    ))}
                </div>
            </div>
        </nav>
    );
}

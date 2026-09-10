/*
 * src/renderer/src/components/layout/BottomNav.tsx - the bottom navigation, ported from
 * src/renderer/bottom-nav.js.
 *
 * Carried over verbatim as content: the four items, their icons, their order, the class strings for
 * the active and inactive states, the "Go to <label>" accessible name, aria-current on the active
 * item, the filled icon on the active item, and the style block the imperative version injected for
 * #bottomNav (the upward shadow, and above the md breakpoint a centred bar capped at 430 px with
 * rounded top corners), expressed here as utility classes instead of an injected <style> element.
 *
 * What disappears: the href column and the click handler. v1.2.1 asked the main process to load a
 * different HTML file; here each item is a NavLink to one of the HashRouter paths in App.tsx, and
 * the active state comes from NavLink's isActive rather than from parsing the page's file name.
 *
 * aria-current: NavLink applies the value passed here only while the link is active, and omits the
 * attribute otherwise - the same behaviour the imperative version implemented by hand.
 *
 * The 430 px cap does not match AppShell's 448 px. See AppShell.tsx - that is Phase 7's and Phase 9's.
 */

import type { CSSProperties, ReactElement } from 'react';
import { NavLink } from 'react-router-dom';

interface NavItem {
    readonly to: string;
    readonly icon: string;
    readonly label: string;
}

const NAV_ITEMS: readonly NavItem[] = [
    { to: '/', icon: 'home', label: 'Home' },
    { to: '/companies', icon: 'business', label: 'Companies' },
    { to: '/history', icon: 'history', label: 'History' },
    { to: '/settings', icon: 'settings', label: 'Settings' }
];

const NAV_CLASS =
    'fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-surface-dark border-t border-slate-200 dark:border-slate-800 ' +
    'shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1),0_-2px_4px_-1px_rgba(0,0,0,0.06)] ' +
    'md:left-1/2 md:-translate-x-1/2 md:max-w-[430px] md:rounded-t-[24px]';

const LINK_CLASS = 'flex items-end justify-center text-center mx-auto px-4 pt-2 w-full transition-colors duration-200';
const LINK_ACTIVE_CLASS = 'text-primary';
const LINK_INACTIVE_CLASS = 'text-gray-400 group-hover:text-primary';

const INDICATOR_CLASS = 'block w-5 mx-auto h-1 rounded-full transition-all duration-200';
const INDICATOR_ACTIVE_CLASS = 'bg-primary';
const INDICATOR_INACTIVE_CLASS = 'bg-transparent group-hover:bg-primary';

const ACTIVE_ICON_STYLE: CSSProperties = { fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" };

const linkClass = (isActive: boolean): string =>
    LINK_CLASS + ' ' + (isActive ? LINK_ACTIVE_CLASS : LINK_INACTIVE_CLASS);

const indicatorClass = (isActive: boolean): string =>
    INDICATOR_CLASS + ' ' + (isActive ? INDICATOR_ACTIVE_CLASS : INDICATOR_INACTIVE_CLASS);

export default function BottomNav(): ReactElement {
    return (
        <nav id="bottomNav" className={NAV_CLASS}>
            <div className="max-w-md mx-auto px-7">
                <div className="flex">
                    {NAV_ITEMS.map((item) => (
                        <div key={item.to} className="flex-1 group">
                            <NavLink
                                to={item.to}
                                end
                                aria-label={'Go to ' + item.label}
                                aria-current="page"
                                className={({ isActive }) => linkClass(isActive)}
                            >
                                {({ isActive }) => (
                                    <span className="block px-1 pt-1 pb-1">
                                        <span
                                            className="material-symbols-outlined text-2xl pt-1 mb-1 block"
                                            style={isActive ? ACTIVE_ICON_STYLE : undefined}
                                        >
                                            {item.icon}
                                        </span>
                                        <span className="block text-xs pb-2">{item.label}</span>
                                        <span className={indicatorClass(isActive)} />
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

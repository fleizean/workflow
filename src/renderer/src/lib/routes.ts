// The four screen paths, as data. app/router.tsx is the only place that maps one to an element; the bottom
// navigation links to the same strings rather than spelling them a second time.

export const ROUTE_PATHS = {
    home: '/',
    companies: '/companies',
    history: '/history',
    settings: '/settings',
    /*
     * PANEL-05: the tray panel. A route rather than a second HTML entry - SPA-01 allows one document, and a second
     * index.html would be a second CSP meta tag and a second renderer build input to keep in step with this one.
     * Nothing in the app links here: main loads the panel window at this hash.
     */
    panel: '/panel'
} as const;

export type RouteKey = keyof typeof ROUTE_PATHS;
export type RoutePath = (typeof ROUTE_PATHS)[RouteKey];

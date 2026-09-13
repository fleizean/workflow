// The four screen paths, as data. app/router.tsx is the only place that maps one to an element; the bottom
// navigation links to the same strings rather than spelling them a second time.

export const ROUTE_PATHS = {
    home: '/',
    companies: '/companies',
    history: '/history',
    settings: '/settings'
} as const;

export type RouteKey = keyof typeof ROUTE_PATHS;
export type RoutePath = (typeof ROUTE_PATHS)[RouteKey];

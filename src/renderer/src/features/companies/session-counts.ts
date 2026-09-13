// How many sessions each company holds. Pure, and exported on its own, because it is what COMP-05's warning quotes:
// a delete that takes work sessions with it has to say how many BEFORE it happens, and the channel can only say so
// afterwards.

import type { WorkSession } from '@shared/types';

export function countSessionsByCompany(sessions: readonly WorkSession[]): ReadonlyMap<number, number> {
    const counts = new Map<number, number>();
    for (const session of sessions) {
        if (session.companyId !== null) {
            counts.set(session.companyId, (counts.get(session.companyId) ?? 0) + 1);
        }
    }
    return counts;
}

/** `1 session` / `3 sessions` - v1.2.1's own pluralisation (legacy/pages/companies.html:131). */
export function describeSessionCount(count: number): string {
    return String(count) + (count === 1 ? ' session' : ' sessions');
}

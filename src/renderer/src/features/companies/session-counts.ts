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

/*
 * COMP-05. The delete cascades, so the confirmation has to say what goes with the company - and it has to say it
 * before the call, because the channel can only report the count once the rows are gone. A user who reads
 * "This action cannot be undone" over an unnamed number of work sessions has not been warned about the thing that
 * actually happens, which is that tracked time is deleted.
 */
export function describeCompanyDelete(count: number): string {
    if (count === 0) {
        return 'This action cannot be undone.';
    }
    return 'This company has ' + describeSessionCount(count) + ' attached to it, and all of them will be ' +
        'permanently deleted with it. This action cannot be undone.';
}

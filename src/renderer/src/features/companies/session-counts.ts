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
 * BL-03. `undefined` above means "this company has no rows in the list I was given"; the screen has to decide
 * whether that list is an answer at all. Two `?? 0`s used to make both cases zero, so a destructive confirmation
 * over a company holding twelve sessions read exactly like one over a company holding none - while the read was in
 * flight, after it had failed, and whenever list() dropped rows the cascade deletes regardless. null is "not known",
 * and it stays distinguishable all the way to the dialog and the row.
 */
export function sessionCountFor(
    counts: ReadonlyMap<number, number>,
    companyId: number,
    listed: boolean
): number | null {
    return listed ? counts.get(companyId) ?? 0 : null;
}

/** What a row shows where a number would go when there is no number to show. */
export const UNKNOWN_SESSION_COUNT = '— sessions';

export function describeRowCount(count: number | null): string {
    return count === null ? UNKNOWN_SESSION_COUNT : describeSessionCount(count);
}

/** Said instead of opening a confirmation that cannot state what it would take. */
export const DELETE_COUNT_UNKNOWN =
    'The session list has not loaded, so this delete cannot say what it would take with it. Try again in a moment.';

/*
 * WR-03. What happened, said by the same condition that colours the toast. The tone was chosen on
 * `removed === expected` and the wording on `removed === 0`, so a warning quoting three sessions over a cascade that
 * removed none produced an orange toast reading "Company deleted successfully", with neither figure in it.
 */
export function describeCompanyDeleted(removed: number, expected: number): string {
    if (removed !== expected) {
        return 'Company deleted. It took ' + describeSessionCount(removed) + ', not the ' +
            describeSessionCount(expected) + ' the warning named.';
    }
    return removed === 0 ? 'Company deleted successfully' : 'Company deleted, with ' + describeSessionCount(removed);
}

/*
 * COMP-05. The delete cascades, so the confirmation has to say what goes with the company, and it has to say it
 * before the call because the channel can only report the count once the rows are gone. A user who reads "This
 * action cannot be undone" over an unnamed number of work sessions has not been warned that tracked time is deleted.
 */
export function describeCompanyDelete(count: number): string {
    if (count === 0) {
        return 'This action cannot be undone.';
    }
    return 'This company has ' + describeSessionCount(count) + ' attached to it, and all of them will be ' +
        'permanently deleted with it. This action cannot be undone.';
}

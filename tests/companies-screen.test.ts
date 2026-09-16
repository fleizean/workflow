/*
 * COMP-05's arithmetic and its wording, run rather than read.
 *
 * The Companies screen itself is not rendered by anything here - there is no jsdom in this project, by decision -
 * so what is provable is the module the warning is built out of and the one that counts what it warns about.
 * That the count reaches the screen, and that the name beside it is text rather than markup, is settled in the
 * packaged smoke (tools/smoke-packaged.mjs).
 */

import { describe, expect, it } from 'vitest';
import {
    DELETE_COUNT_UNKNOWN, UNKNOWN_SESSION_COUNT, countSessionsByCompany, describeCompanyDelete,
    describeCompanyDeleted, describeRowCount,
    describeSessionCount, sessionCountFor
} from '@renderer/features/companies/session-counts';
import { read } from './helpers/ts-imports';
import type { LocalDate, WorkSession } from '@shared/types';

const DAY = '2026-09-13' as LocalDate;

const session = (id: number, companyId: number | null): WorkSession => ({
    id,
    name: 'Work Session',
    durationSeconds: 3600,
    date: DAY,
    companyId,
    note: null,
    createdAt: 1_757_000_000_000
});

describe('countSessionsByCompany', () => {
    it('counts each company separately', () => {
        const counts = countSessionsByCompany([session(1, 7), session(2, 7), session(3, 9)]);
        expect(counts.get(7)).toBe(2);
        expect(counts.get(9)).toBe(1);
    });

    it('answers nothing for a company with no sessions, rather than zero it never saw', () => {
        expect(countSessionsByCompany([]).get(7)).toBeUndefined();
    });

    it('ignores a session attributed to no company, which cannot be deleted with one', () => {
        const counts = countSessionsByCompany([session(1, null), session(2, null), session(3, 4)]);
        expect([...counts.keys()]).toEqual([4]);
        expect(counts.get(4)).toBe(1);
    });
});

describe('describeSessionCount: v1.2.1\'s own pluralisation', () => {
    it.each([[0, '0 sessions'], [1, '1 session'], [2, '2 sessions'], [11, '11 sessions']])(
        '%i reads as %s',
        (count, expected) => { expect(describeSessionCount(count)).toBe(expected); }
    );
});

/*
 * Criterion 1: "a warning naming the sessions attached to it". The number is the whole point - a delete that
 * cascades over tracked time and says only "this cannot be undone" has not told the user what happens.
 */
describe('describeCompanyDelete names what the delete takes with it', () => {
    it('says the count, and that the sessions are deleted, whenever there are any', () => {
        const warning = describeCompanyDelete(3);
        expect(warning, 'the warning does not name the number of sessions').toContain('3 sessions');
        expect(warning.toLowerCase()).toContain('permanently deleted');
        expect(warning.toLowerCase()).toContain('cannot be undone');
    });

    it('uses the singular for one session', () => {
        expect(describeCompanyDelete(1)).toContain('1 session attached');
    });

    it('claims no sessions when the company holds none', () => {
        const warning = describeCompanyDelete(0);
        expect(warning).toBe('This action cannot be undone.');
        expect(warning, 'a company with no sessions must not be described as losing any').not.toContain('session');
    });

    it('is built from the same count the rows are, so the warning and the list cannot disagree', () => {
        const sessions = [session(1, 7), session(2, 7), session(3, 7), session(4, 9)];
        const counts = countSessionsByCompany(sessions);
        expect(describeCompanyDelete(counts.get(7) ?? 0)).toContain('3 sessions');
        expect(describeCompanyDelete(counts.get(9) ?? 0)).toContain('1 session');
    });
});

/*
 * 08-REVIEW-SCREENS BL-03. countSessionsByCompany deliberately answers `undefined` for a company it has no rows
 * for - the test above asserts exactly that - and CompaniesPage collapsed the distinction twice with `?? 0`. So a
 * company holding twelve sessions could be deleted behind the wording written for a company holding none, and the
 * row behind the dialog said "0 sessions".
 *
 * Three ways to get there, all reachable: the session list still in flight (nothing gates on isPending), the
 * session list failed (retry is false, so one transient failure is enough, and the toast auto-dismisses), and a
 * list that is short because sessions.repository.ts drops rows it cannot map while the cascade deletes them
 * regardless.
 *
 * Unknown is not zero. These pin the vocabulary that keeps it separate all the way to the dialog.
 */
describe('BL-03: a count nobody has is not a count of nothing', () => {
    it('reads a company with sessions and a company without, from a list that has loaded', () => {
        const counts = countSessionsByCompany([session(1, 7)]);
        expect(sessionCountFor(counts, 7, true)).toBe(1);
        expect(sessionCountFor(counts, 9, true)).toBe(0);
    });

    it('answers null for every company while the session list has not loaded', () => {
        const counts = countSessionsByCompany([]);
        expect(sessionCountFor(counts, 7, false)).toBeNull();
        expect(sessionCountFor(counts, 9, false)).toBeNull();
    });

    it('renders a dash rather than "0 sessions" for a count it does not have', () => {
        expect(describeRowCount(null)).toBe(UNKNOWN_SESSION_COUNT);
        expect(describeRowCount(null)).not.toContain('0');
        expect(describeRowCount(0)).toBe('0 sessions');
        expect(describeRowCount(3)).toBe('3 sessions');
    });

    it('refuses the destructive confirm rather than opening one over a number it cannot state', () => {
        expect(DELETE_COUNT_UNKNOWN.toLowerCase()).toContain('not loaded');
        expect(DELETE_COUNT_UNKNOWN.toLowerCase()).toContain('delete');
    });

    it('holds the screen to asking the session query whether it has an answer', () => {
        const page = read('src/renderer/src/features/companies/CompaniesPage.tsx');
        expect(page).toContain('sessions.isSuccess');
        expect(page).toContain('DELETE_COUNT_UNKNOWN');
        // The two `?? 0`s that discarded the distinction. Neither may come back.
        expect(page).not.toContain('counts.get(company.id) ?? 0');
    });
});

/*
 * 08-REVIEW-SCREENS WR-03. The tone was chosen on `removed === expected` and the wording on `removed === 0`, so a
 * warning that quoted three sessions over a cascade that removed none produced an orange toast reading "Company
 * deleted successfully" - a mismatch reported with the words of a success, and without the real figure. 08-A and
 * parity row 83 both claim the toast is "a warning naming the real figure rather than a success"; for that branch
 * it was neither.
 */
describe('WR-03: the delete toast says the same thing its colour does', () => {
    it('congratulates only when the cascade took what the warning named', () => {
        expect(describeCompanyDeleted(0, 0)).toBe('Company deleted successfully');
        expect(describeCompanyDeleted(3, 3)).toContain('3 sessions');
        expect(describeCompanyDeleted(3, 3)).not.toContain('not the');
    });

    it('names both figures when they disagree, in either direction', () => {
        const under = describeCompanyDeleted(0, 3);
        expect(under).not.toContain('successfully');
        expect(under).toContain('0 sessions');
        expect(under).toContain('3 sessions');

        const over = describeCompanyDeleted(5, 3);
        expect(over).toContain('5 sessions');
        expect(over).toContain('3 sessions');
    });

    it('is worded by the same condition that colours it', () => {
        const page = read('src/renderer/src/features/companies/CompaniesPage.tsx');
        expect(page).not.toContain('removed === 0');
        expect(page).toContain('describeCompanyDeleted(removed, expected)');
    });
});

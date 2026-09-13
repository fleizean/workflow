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
    countSessionsByCompany, describeCompanyDelete, describeSessionCount
} from '@renderer/features/companies/session-counts';
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

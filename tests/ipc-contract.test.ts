// SHARED-04..06 (D-16..D-20): one contract map, a day on the wire only as a validated LocalDate, types by inference.
// Type proofs sit in exported functions that never run; `npm run typecheck` enforces them.
import { describe, expect, it } from 'vitest';
import { ipcContract } from '@shared/ipc/contract';
import type { IpcApi, IpcHandlers } from '@shared/ipc/contract';
import { LocalDateSchema, WorkSessionSchema } from '@shared/schemas';
import { isLocalDate } from '@shared/utils/date';
import type { LocalDate } from '@shared/utils/date';

const isoOnTheWire: unknown = JSON.parse(JSON.stringify(new Date()));

const REJECTED_DAYS: [string, unknown][] = [
    ['a Date object', new Date()],
    ['the ISO string a Date becomes in JSON', isoOnTheWire],
    ['an unpadded month', '2026-9-10'],
    ['a day that does not exist', '2026-02-30'],
    ['a number', 20260910],
    ['null', null]
];

const WELL_FORMED_SESSION = {
    id: 1,
    name: 'Deep work',
    durationSeconds: 3600,
    date: '2026-09-10',
    companyId: null,
    note: null,
    createdAt: 1789000000000
};

describe('SHARED-04 / D-19: LocalDateSchema', () => {
    it('accepts a real local day, exactly as isLocalDate does', () => {
        expect(LocalDateSchema.safeParse('2026-09-10').success).toBe(true);
        expect(isLocalDate('2026-09-10'), 'the @shared alias resolved to a different date module').toBe(true);
    });

    it.each(REJECTED_DAYS)('rejects %s', (_label, value) => {
        expect(LocalDateSchema.safeParse(value).success, 'SHARED-04: a non-LocalDate day would reach the wire').toBe(false);
        expect(isLocalDate(value)).toBe(false);
    });
});

describe('D-16: the sessions channels validate through the contract map', () => {
    const range = ipcContract['sessions:listByDateRange'].input;

    it('rejects a Date where the contract expects a day', () => {
        expect(range.safeParse({ startDate: new Date(), endDate: '2026-09-10' }).success,
            'SHARED-04: a Date crossed the contract and would be JSON-serialised as a UTC instant').toBe(false);
        expect(range.safeParse({ startDate: '2026-09-01', endDate: '2026-09-10' }).success).toBe(true);
    });

    it('rejects an unknown key (strictObject)', () => {
        expect(range.safeParse({ startDate: '2026-09-01', endDate: '2026-09-10', extra: 1 }).success,
            'T-03-14: an object input accepted a key the contract does not declare').toBe(false);
    });

    it('WorkSessionSchema accepts a well-formed session and rejects a fractional duration', () => {
        expect(WorkSessionSchema.safeParse(WELL_FORMED_SESSION).success).toBe(true);
        expect(WorkSessionSchema.safeParse({ ...WELL_FORMED_SESSION, durationSeconds: 1.5 }).success,
            'D-19: durations are whole seconds').toBe(false);
    });
});

export function tracerTypeProofs(api: IpcApi, day: LocalDate): void {
    // @ts-expect-error a Date is not a LocalDate
    void api['sessions:listByDateRange']({ startDate: new Date(), endDate: day });
    // @ts-expect-error every channel needs a handler
    const none: IpcHandlers = {};
    void none;
}

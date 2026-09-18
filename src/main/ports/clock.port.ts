// The clock the services read. Wall time names a day; monotonic time measures one. Keeping them apart is what stops
// a system-clock change, a DST step or a suspended machine from inventing or destroying tracked time (X1, CORE-04).

import { formatLocalDate, instantFromEpochMs } from '@shared/utils/date';
import type { LocalDate } from '@shared/types';

export interface ClockPort {
    /** Epoch milliseconds. Jumps when the system clock is set, so it may name an instant but never measure one. */
    now(): number;
    /** Milliseconds from an arbitrary origin, never decreasing. Use it to measure an interval, never to name one. */
    monotonicNow(): number;
}

/** The local calendar day the wall clock is on. The Date construction stays inside date.ts (SHARED-03). */
export function localDayOf(clock: ClockPort): LocalDate {
    return formatLocalDate(instantFromEpochMs(clock.now()));
}

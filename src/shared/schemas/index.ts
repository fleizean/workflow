// Wire schemas (D-19): days are LocalDate, instants integer epoch ms, durations whole seconds.
// No transforms and no defaults, so z.input equals z.output and one inferred type serves both ends.
import { z } from 'zod';
import { isLocalDate } from '@shared/utils/date';
import type { LocalDate } from '@shared/utils/date';

// z.custom, not a string refine: a refine would infer string rather than LocalDate.
export const LocalDateSchema = z.custom<LocalDate>(isLocalDate, 'Expected a local calendar day in YYYY-MM-DD form');

export const IdSchema = z.int().positive();
export const EpochMsSchema = z.int().nonnegative();
export const DurationSecondsSchema = z.int().nonnegative();

export const WorkSessionSchema = z.strictObject({
    id: IdSchema,
    name: z.string(),
    durationSeconds: DurationSecondsSchema,
    date: LocalDateSchema,
    companyId: IdSchema.nullable(),
    note: z.string().nullable(),
    // v1.2.1 shows a session's creation time on Work History.
    createdAt: EpochMsSchema
});

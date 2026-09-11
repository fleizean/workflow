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

// The Google Sheets target, grouped so the Phase 5 export seam can own it without renaming Company (D-20).
export const SheetsTargetSchema = z.strictObject({
    excelColumn: z.string().nullable(),
    noteColumn: z.string().nullable()
});

export const CompanySchema = z.strictObject({
    id: IdSchema,
    name: z.string().min(1),
    noteRequired: z.boolean(),
    sheets: SheetsTargetSchema,
    // v1.2.1 shows a company's creation date on Companies.
    createdAt: EpochMsSchema
});

// No createdAt: v1.2.1 displays no pomodoro record.
export const PomodoroSessionSchema = z.strictObject({
    id: IdSchema,
    date: LocalDateSchema,
    companyId: IdSchema.nullable(),
    pomodorosCompleted: z.int().nonnegative()
});

// Exactly the 12 keys v1.2.1 reads or writes (D-20); the two seeded-but-unread keys stay out.
export const SettingsSchema = z.strictObject({
    dailyTargetSeconds: z.int().positive(),
    goalNotification: z.boolean(),
    excludeWeekendsFromStreak: z.boolean(),
    pomodoroEnabled: z.boolean(),
    pomodoroWorkSeconds: z.int().positive(),
    pomodoroShortBreakSeconds: z.int().positive(),
    pomodoroLongBreakSeconds: z.int().positive(),
    pomodoroSessionsUntilLongBreak: z.int().positive(),
    pomodoroAutoStartBreaks: z.boolean(),
    pomodoroAutoStartWork: z.boolean(),
    exportHalfHourPrecision: z.boolean(),
    scriptUrl: z.string()
});

// Where settings:update may point the export (WR-06): unset, or https to the Apps Script host with no port, credentials
// or whitespace. Reads keep z.string(), so a stored v1.2.1 value can never make every setting unreadable.
export const ScriptUrlSchema = z.union([z.literal(''), z.string().regex(/^https:\/\/script\.google\.com\/[\x21-\x7E]*$/)]);

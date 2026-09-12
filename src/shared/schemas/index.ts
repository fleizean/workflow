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

export const CompanySchema = z.strictObject({
    id: IdSchema,
    name: z.string().min(1),
    noteRequired: z.boolean(),
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

// The 10 keys v1.2.1 reads or writes that v2 still has a use for (D-20). Out: the two seeded-but-unread keys, and
// export_half_hour_precision / script_url, whose rows stay in the database after the owner removed the export.
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
    pomodoroAutoStartWork: z.boolean()
});

// The sounds main asks the renderer to play. Main owns the decision and the clock; the renderer owns the audio
// element, as v1.2.1's `new Audio(...)` did. Slice E adds the pomodoro sound with the cycle that raises it.
export const SoundIdSchema = z.enum(['goalReached']);

// The timer's own vocabulary. Status and mode are separate axes, which is what lets a mode change leave what has
// already been counted alone (CORE-14, CB-1).
export const TimerStatusSchema = z.enum(['idle', 'running', 'paused']);
export const TimerModeSchema = z.enum(['work', 'pomodoro']);

// What main pushes to the renderer on every tick. elapsedSeconds is the whole of it: the renderer does no arithmetic
// (X1), so there is no start timestamp here for it to subtract from (CORE-07).
export const TimerSnapshotSchema = z.strictObject({
    status: TimerStatusSchema,
    mode: TimerModeSchema,
    elapsedSeconds: DurationSecondsSchema,
    // G3/G4: time carried over from a previous launch is offered for saving or discarding, never auto-resumed.
    restoredFromPreviousLaunch: z.boolean()
});

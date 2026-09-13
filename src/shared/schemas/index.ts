// Wire schemas (D-19): days are LocalDate, instants integer epoch ms, durations whole seconds.
// No transforms and no defaults, so z.input equals z.output and one inferred type serves both ends.
import { z } from 'zod';
import {
    MAX_SESSION_DURATION_SECONDS, MAX_SESSION_NAME_LENGTH, MAX_SESSION_NOTE_LENGTH
} from '@shared/constants/sessions';
import { isLocalDate } from '@shared/utils/date';
import type { LocalDate } from '@shared/utils/date';

// z.custom, not a string refine: a refine would infer string rather than LocalDate.
export const LocalDateSchema = z.custom<LocalDate>(isLocalDate, 'Expected a local calendar day in YYYY-MM-DD form');

export const IdSchema = z.int().positive();
export const EpochMsSchema = z.int().nonnegative();
export const DurationSecondsSchema = z.int().nonnegative();

/*
 * WR-07: the three fields a caller writes a session with, bounded. They are separate from the schemas above
 * because those describe what is read: a week total is longer than a day by design, a running timer's elapsed
 * seconds can be, and a migrated v1.2.1 row may be.
 */
export const SessionDurationSecondsSchema = z.int().nonnegative().max(MAX_SESSION_DURATION_SECONDS);
export const SessionNameSchema = z.string().min(1).max(MAX_SESSION_NAME_LENGTH)
    // A name of spaces is an unnamed session that renders as a blank row nobody can tell apart from another.
    .refine((name) => name.trim() !== '', 'A session needs a name');
export const SessionNoteSchema = z.string().max(MAX_SESSION_NOTE_LENGTH).nullable();

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
// export_half_hour_precision / script_url, which migration 0002 deleted along with the export that wrote them.
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
// element, as v1.2.1's `new Audio(...)` did.
export const SoundIdSchema = z.enum(['goalReached', 'pomodoroCompleted']);

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
    restoredFromPreviousLaunch: z.boolean(),
    /*
     * WR-04: the last attempt to write the counted seconds did not land. The clock keeps running - the value is
     * still in memory and stopping would be worse - but a reboot now costs everything since the first failure, so
     * the user has to be able to see that they should write the time down somewhere.
     */
    persistFailing: z.boolean()
});

// The pomodoro cycle's vocabulary. The interval names are the state machine's, and completedToday is read from the
// database for the day it names - never a number the renderer increments (CORE-12).
export const PomodoroIntervalSchema = z.enum(['work', 'shortBreak', 'longBreak']);
export const PomodoroStatusSchema = z.enum(['idle', 'running', 'paused']);

export const PomodoroSnapshotSchema = z.strictObject({
    interval: PomodoroIntervalSchema,
    status: PomodoroStatusSchema,
    elapsedSeconds: DurationSecondsSchema,
    targetSeconds: DurationSecondsSchema,
    remainingSeconds: DurationSecondsSchema,
    date: LocalDateSchema,
    completedToday: z.int().nonnegative(),
    sessionsUntilLongBreak: z.int().positive(),
    // CR-01: an interval that reached its target and could not be written. The seconds above are still the ones it
    // earned, held rather than discarded, so a screen can offer the retry instead of reporting a break that started.
    recordingFailed: z.boolean()
});

// POMO-09: how many pomodoros the day and the Monday-to-Sunday week hold.
export const PomodoroCountsSchema = z.strictObject({
    date: LocalDateSchema,
    todayCount: z.int().nonnegative(),
    thisWeekCount: z.int().nonnegative()
});

// CORE-08: the streak, the two week totals and one day's progress - each a whole day's total against the target,
// never a single session's duration (B7).
export const StreakSchema = z.strictObject({ date: LocalDateSchema, days: z.int().nonnegative() });

export const WeekTotalsSchema = z.strictObject({
    thisWeekSeconds: DurationSecondsSchema,
    lastWeekSeconds: DurationSecondsSchema
});

export const DayProgressSchema = z.strictObject({
    date: LocalDateSchema,
    totalSeconds: DurationSecondsSchema,
    dailyTargetSeconds: z.int().positive(),
    goalMet: z.boolean()
});

// Domain types inferred from the wire schemas (D-19). Type-only, so importing this never loads zod.
import type { z } from 'zod';
import type {
    CompanySchema, DayProgressSchema, PomodoroCountsSchema, PomodoroIntervalSchema, PomodoroSessionSchema,
    PomodoroSnapshotSchema, PomodoroStatusSchema, SettingsSchema, SoundIdSchema, StreakSchema, TimerModeSchema,
    TimerSnapshotSchema, TimerStatusSchema, WeekTotalsSchema, WorkSessionSchema
} from '@shared/schemas';
import type { LocalDate } from '@shared/utils/date';

export type Company = z.infer<typeof CompanySchema>;
export type WorkSession = z.infer<typeof WorkSessionSchema>;
export type PomodoroSession = z.infer<typeof PomodoroSessionSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type SoundId = z.infer<typeof SoundIdSchema>;

// The authoritative timer's shape. It lives in main (X1); this is the value the renderer mirrors.
export type TimerStatus = z.infer<typeof TimerStatusSchema>;
export type TimerMode = z.infer<typeof TimerModeSchema>;
export type TimerSnapshot = z.infer<typeof TimerSnapshotSchema>;

// The pomodoro cycle's shape, and the statistics every screen reads (CORE-08, CORE-12).
export type PomodoroInterval = z.infer<typeof PomodoroIntervalSchema>;
export type PomodoroStatus = z.infer<typeof PomodoroStatusSchema>;
export type PomodoroSnapshot = z.infer<typeof PomodoroSnapshotSchema>;
export type PomodoroCounts = z.infer<typeof PomodoroCountsSchema>;
export type Streak = z.infer<typeof StreakSchema>;
export type WeekTotals = z.infer<typeof WeekTotalsSchema>;
export type DayProgress = z.infer<typeof DayProgressSchema>;

// One local day's tracked total. Every statistic is computed from these, never from a single session (CORE-08, B7).
export interface DayTotal {
    readonly date: LocalDate;
    readonly totalSeconds: number;
}

export type { LocalDate };
export type {
    IpcApi, IpcBridge, IpcChannel, IpcError, IpcEventChannel, IpcEventPayload, IpcEventSubscriptions, IpcHandlers,
    IpcInput, IpcOutput, IpcResult
} from '@shared/ipc/contract';

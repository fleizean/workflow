// Domain types inferred from the wire schemas (D-19). Type-only, so importing this never loads zod.
import type { z } from 'zod';
import type {
    CompanySchema, PomodoroSessionSchema, SettingsSchema, SoundIdSchema, TimerModeSchema, TimerSnapshotSchema,
    TimerStatusSchema, WorkSessionSchema
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

// One local day's tracked total. Every statistic is computed from these, never from a single session (CORE-08, B7).
export interface DayTotal {
    readonly date: LocalDate;
    readonly totalSeconds: number;
}

export type { LocalDate };
export type {
    IpcApi, IpcChannel, IpcError, IpcEventChannel, IpcEventPayload, IpcInput, IpcOutput, IpcResult
} from '@shared/ipc/contract';

// Domain types inferred from the wire schemas (D-19). Type-only, so importing this never loads zod.
import type { z } from 'zod';
import type { CompanySchema, PomodoroSessionSchema, SettingsSchema, WorkSessionSchema } from '@shared/schemas';

export type Company = z.infer<typeof CompanySchema>;
export type WorkSession = z.infer<typeof WorkSessionSchema>;
export type PomodoroSession = z.infer<typeof PomodoroSessionSchema>;
export type Settings = z.infer<typeof SettingsSchema>;

export type { LocalDate } from '@shared/utils/date';
export type { IpcApi, IpcChannel, IpcError, IpcInput, IpcOutput, IpcResult } from '@shared/ipc/contract';

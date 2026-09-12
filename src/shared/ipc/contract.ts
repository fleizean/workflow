// The one IPC contract (D-16): every channel name, payload schema and both ends' types derive from ipcContract.
import { z } from 'zod';
import {
    CompanySchema, DayProgressSchema, DurationSecondsSchema, IdSchema, LocalDateSchema, PomodoroCountsSchema,
    PomodoroSnapshotSchema, SettingsSchema, SoundIdSchema, StreakSchema, TimerModeSchema, TimerSnapshotSchema,
    WeekTotalsSchema, WorkSessionSchema
} from '@shared/schemas';
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '@shared/ipc/channels';
import type { DeclaredIpcChannel, DeclaredIpcEventChannel } from '@shared/ipc/channels';
import type { IpcErrorCode } from '@shared/constants/ipc-errors';

type ChannelName = `${string}:${string}`;

interface ChannelSpec {
    readonly input: z.ZodType;
    readonly output: z.ZodType;
}

export type ContractMap = Readonly<Record<ChannelName, ChannelSpec>>;

// A z.void() channel is called with no argument at all.
type ArgsOf<I> = [I] extends [void] ? [] : [input: I];

// Code and message only: a stack never crosses IPC (D-17).
export interface IpcError {
    readonly code: IpcErrorCode;
    readonly message: string;
}

export type IpcResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: IpcError };

// Keyed by keyof M & ChannelName so that M[C] is known to be a ChannelSpec.
export type ApiOf<M extends ContractMap> = {
    readonly [C in keyof M & ChannelName]: (...args: ArgsOf<z.input<M[C]['input']>>) => Promise<IpcResult<z.output<M[C]['output']>>>;
};

export type HandlersOf<M extends ContractMap> = {
    readonly [C in keyof M & ChannelName]: (input: z.input<M[C]['input']>) => z.output<M[C]['output']> | Promise<z.output<M[C]['output']>>;
};

const sessionFields = {
    name: z.string(),
    durationSeconds: DurationSecondsSchema,
    date: LocalDateSchema,
    companyId: IdSchema.nullable(),
    note: z.string().nullable()
};

export const ipcContract = {
    'sessions:list': { input: z.void(), output: z.array(WorkSessionSchema) },
    'sessions:listByDateRange': {
        input: z.strictObject({ startDate: LocalDateSchema, endDate: LocalDateSchema }),
        output: z.array(WorkSessionSchema)
    },
    'sessions:listByDateAndCompany': {
        input: z.strictObject({ date: LocalDateSchema, companyId: IdSchema }),
        output: z.array(WorkSessionSchema)
    },
    'sessions:create': { input: z.strictObject(sessionFields), output: WorkSessionSchema },
    'sessions:update': { input: z.strictObject({ id: IdSchema, ...sessionFields }), output: WorkSessionSchema },
    'sessions:delete': { input: z.strictObject({ id: IdSchema }), output: z.void() },
    // Irreversible, so the caller must spell the confirmation and learns what it removed (WR-05).
    'sessions:deleteAll': {
        input: z.strictObject({ confirm: z.literal('DELETE_ALL_SESSIONS') }),
        output: z.strictObject({ deletedSessionCount: z.int().nonnegative() })
    },
    'companies:list': { input: z.void(), output: z.array(CompanySchema) },
    'companies:get': { input: z.strictObject({ id: IdSchema }), output: CompanySchema.nullable() },
    'companies:create': {
        input: z.strictObject({ name: z.string().min(1), noteRequired: z.boolean() }),
        output: CompanySchema
    },
    'companies:update': {
        input: z.strictObject({ id: IdSchema, name: z.string().min(1), noteRequired: z.boolean() }),
        output: CompanySchema
    },
    // The delete reports how many sessions went with the company (COMP-05).
    'companies:delete': {
        input: z.strictObject({ id: IdSchema }),
        output: z.strictObject({ deletedSessionCount: z.int().nonnegative() })
    },
    'settings:get': { input: z.void(), output: SettingsSchema },
    // Partial: the form sends the keys it changed, never the whole settings object.
    'settings:update': { input: SettingsSchema.partial(), output: SettingsSchema },
    // The clock lives in main (X1), so each of these is a request to it rather than a report from the renderer.
    'timer:getSnapshot': { input: z.void(), output: TimerSnapshotSchema },
    'timer:start': { input: z.void(), output: TimerSnapshotSchema },
    'timer:pause': { input: z.void(), output: TimerSnapshotSchema },
    'timer:reset': { input: z.void(), output: TimerSnapshotSchema },
    'timer:setMode': { input: z.strictObject({ mode: TimerModeSchema }), output: TimerSnapshotSchema },
    'pomodoro:getSnapshot': { input: z.void(), output: PomodoroSnapshotSchema },
    'pomodoro:start': { input: z.void(), output: PomodoroSnapshotSchema },
    'pomodoro:pause': { input: z.void(), output: PomodoroSnapshotSchema },
    // Abandons the interval in flight; skipBreak ends a break early. Neither completes anything (CORE-12).
    'pomodoro:abort': { input: z.void(), output: PomodoroSnapshotSchema },
    'pomodoro:skipBreak': { input: z.void(), output: PomodoroSnapshotSchema },
    'pomodoro:counts': { input: z.void(), output: PomodoroCountsSchema },
    'stats:streak': { input: z.void(), output: StreakSchema },
    'stats:weekTotals': { input: z.void(), output: WeekTotalsSchema },
    'stats:dayProgress': { input: z.strictObject({ date: LocalDateSchema }), output: DayProgressSchema },
    // v1.2.1's minimize and close both hid to the tray, and the titlebar is the renderer's (IPC-05).
    'window:minimize': { input: z.void(), output: z.void() },
    'window:close': { input: z.void(), output: z.void() }
} as const satisfies ContractMap;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]['output']>;
export type IpcApi = ApiOf<IpcContract>;
export type IpcHandlers = HandlersOf<IpcContract>;

// A channel named in channels.ts and not here, or here and not there, is a compile error rather than a bridge method
// that resolves to nothing. Both directions, so neither list can grow alone.
type Covers<Super, Sub extends Super> = [Sub] extends [Super] ? true : never;
export type ChannelsMatchTheContract = [Covers<IpcChannel, DeclaredIpcChannel>, Covers<DeclaredIpcChannel, IpcChannel>];

/** The channel names in declaration order, for a caller that registers or bridges every one of them. */
export const ipcChannels: readonly IpcChannel[] = IPC_CHANNELS;

// Main-to-renderer events; each entry arrives with the phase that designs the event (D-20).
export const ipcEvents = {
    // The main process decides when a sound is due; only the renderer can play one.
    'app:playSound': z.strictObject({ sound: SoundIdSchema }),
    // One message per second carrying a whole snapshot, so the renderer stores what it is told and computes nothing.
    'timer:tick': TimerSnapshotSchema,
    // The same for the cycle: every state change, including each tick, arrives as a whole snapshot.
    'pomodoro:tick': PomodoroSnapshotSchema
} as const satisfies Readonly<Record<ChannelName, z.ZodType>>;
export type IpcEventChannel = keyof typeof ipcEvents;
export type EventChannelsMatchTheContract =
    [Covers<IpcEventChannel, DeclaredIpcEventChannel>, Covers<DeclaredIpcEventChannel, IpcEventChannel>];
export const ipcEventChannels: readonly IpcEventChannel[] = IPC_EVENT_CHANNELS;
export type IpcEventPayload<C extends IpcEventChannel> = z.output<(typeof ipcEvents)[C]>;

// IPC-06: every subscription returns its own disposer, and a listener is handed the payload alone - never the
// IpcRendererEvent, which carries a sender the renderer has no business holding.
export type IpcEventSubscriptions = {
    readonly [C in IpcEventChannel]: (listener: (payload: IpcEventPayload<C>) => void) => () => void;
};

/** What the preload exposes: one method per channel, plus the event subscriptions under `on`. */
export type IpcBridge = IpcApi & { readonly on: IpcEventSubscriptions };

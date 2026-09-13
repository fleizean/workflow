// The one IPC contract (D-16): every channel name, payload schema and both ends' types derive from ipcContract.
import { z } from 'zod';
import {
    CompanySchema, DayProgressSchema, IdSchema, LocalDateSchema, PomodoroCountsSchema,
    PomodoroSnapshotSchema, SessionDurationSecondsSchema, SessionNameSchema, SessionNoteSchema, SettingsSchema,
    SoundIdSchema, StreakSchema, TimerModeSchema, TimerSnapshotSchema, WeekTotalsSchema, WorkSessionSchema
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

// WR-07: bounded at the boundary, so a duration arithmetic slip or a blank form on a later screen is refused
// here rather than written to a row every statistic then counts.
const sessionFields = {
    name: SessionNameSchema,
    durationSeconds: SessionDurationSecondsSchema,
    date: LocalDateSchema,
    companyId: IdSchema.nullable(),
    note: SessionNoteSchema
};

export const ipcContract = {
    'sessions:list': { input: z.void(), output: z.array(WorkSessionSchema) },
    'sessions:listByDateRange': {
        // WR-07: a reversed range is a bug in the caller, not an empty week. BETWEEN would answer nothing and the
        // screen would show days that hold work as days that hold none.
        input: z.strictObject({ startDate: LocalDateSchema, endDate: LocalDateSchema })
            .refine((range) => range.startDate <= range.endDate, 'endDate must not be before startDate'),
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
    /*
     * WR-06: stopping the timer to record work is one call, because two cannot be atomic. `sessions:create` then
     * `timer:reset` leaves the session on disk and the seconds still counted if the process dies between them, and
     * G3/G4 then offers the same work to be saved again; the other order zeroes the accumulator with nothing
     * written. The session that comes back is the one that was written.
     */
    'timer:stopAndSave': { input: z.strictObject(sessionFields), output: WorkSessionSchema },
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
    /*
     * Owner decision 2026-09-13: the two titlebar buttons no longer mean the same thing, so the channel says which
     * one is being asked for. v1.2.1 sent both to one hide (legacy/renderer/titlebar.js), and `window:close` - which
     * hid rather than closed - is retired rather than quietly redefined. Where the window goes is still main's
     * decision, not the renderer's (IPC-05): with no tray to hide to, hide minimises to the taskbar instead.
     */
    'window:hide': { input: z.void(), output: z.void() },
    /*
     * True once, ever. A user who believes they closed the app while it keeps counting has misunderstood something,
     * and a misunderstanding is corrected once - a confirm on every hide only teaches people to click through
     * dialogs. Asked before hiding, because a notice raised after it is behind a window that is no longer there.
     */
    'window:claimHideNotice': { input: z.void(), output: z.strictObject({ due: z.boolean() }) },
    /** Ends the process. The renderer asks only after its own confirm; main marks the quit so nothing re-hides. */
    'app:quit': { input: z.void(), output: z.void() }
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

/*
 * SPA-07. What a write changed, named in the vocabulary every channel is already namespaced in, so a domain and a
 * channel prefix cannot mean two different things.
 *
 * stats and pomodoro are listed although no query reads them yet: `timer:stopAndSave` really does change what a
 * streak or a day's progress would answer, and announcing it now costs an invalidation of a cache nobody has
 * subscribed to. Phase 8 adds the screens, not the announcement.
 */
export const DATA_DOMAINS = ['sessions', 'companies', 'settings', 'timer', 'pomodoro', 'stats'] as const;
export type DataDomain = (typeof DATA_DOMAINS)[number];
const DataDomainSchema = z.enum(DATA_DOMAINS);

/**
 * Which domains a successful call to each channel changed - `satisfies` over the whole contract, so a channel added
 * without an answer here is a compile error rather than a screen that quietly stops refreshing. An empty list is
 * the answer for a read, and it is stated rather than omitted.
 */
export const ipcWrites = {
    'sessions:list': [],
    'sessions:listByDateRange': [],
    'sessions:listByDateAndCompany': [],
    'sessions:create': ['sessions', 'stats'],
    'sessions:update': ['sessions', 'stats'],
    'sessions:delete': ['sessions', 'stats'],
    'sessions:deleteAll': ['sessions', 'stats'],
    'companies:list': [],
    'companies:get': [],
    'companies:create': ['companies'],
    'companies:update': ['companies'],
    // COMP-05: deleting a company takes its sessions with it, which is why the call reports how many.
    'companies:delete': ['companies', 'sessions', 'stats'],
    'settings:get': [],
    // The daily target is a setting, and it is what dayProgress measures against. WR-04: so are all four values
    // PomodoroSnapshot carries - container.ts feeds the pomodoro service durations: () => settings.get() - so a
    // settings write changes what pomodoro:getSnapshot would answer.
    'settings:update': ['settings', 'stats', 'pomodoro'],
    'timer:getSnapshot': [],
    'timer:start': ['timer'],
    'timer:pause': ['timer'],
    'timer:reset': ['timer'],
    'timer:setMode': ['timer'],
    'timer:stopAndSave': ['timer', 'sessions', 'stats'],
    'pomodoro:getSnapshot': [],
    'pomodoro:start': ['pomodoro'],
    'pomodoro:pause': ['pomodoro'],
    'pomodoro:abort': ['pomodoro'],
    'pomodoro:skipBreak': ['pomodoro'],
    'pomodoro:counts': [],
    'stats:streak': [],
    'stats:weekTotals': [],
    'stats:dayProgress': [],
    // The window and the process; nothing the renderer caches depends on either.
    'window:hide': [],
    'window:claimHideNotice': [],
    'app:quit': []
} as const satisfies Readonly<Record<IpcChannel, readonly DataDomain[]>>;

// Main-to-renderer events; each entry arrives with the phase that designs the event (D-20).
export const ipcEvents = {
    // The main process decides when a sound is due; only the renderer can play one.
    'app:playSound': z.strictObject({ sound: SoundIdSchema }),
    // One message per second carrying a whole snapshot, so the renderer stores what it is told and computes nothing.
    'timer:tick': TimerSnapshotSchema,
    // The same for the cycle: every state change, including each tick, arrives as a whole snapshot.
    'pomodoro:tick': PomodoroSnapshotSchema,
    /*
     * SPA-07: main saying what it changed, so the views that show it refresh. It carries domains and never rows -
     * the renderer refetches through the same channels it reads with, so an event cannot become a second, quieter
     * way for data to enter the cache.
     */
    'data:changed': z.strictObject({ domains: z.array(DataDomainSchema).min(1) })
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

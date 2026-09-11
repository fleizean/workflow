// The one IPC contract (D-16): every channel name, payload schema and both ends' types derive from ipcContract.
import { z } from 'zod';
import {
    CompanySchema, DurationSecondsSchema, IdSchema, LocalDateSchema, ScriptUrlSchema, SettingsSchema, SheetsTargetSchema,
    WorkSessionSchema
} from '@shared/schemas';
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
        input: z.strictObject({ id: IdSchema, name: z.string().min(1), noteRequired: z.boolean(), sheets: SheetsTargetSchema }),
        output: CompanySchema
    },
    'companies:updateSheetsTarget': {
        input: z.strictObject({ id: IdSchema, sheets: SheetsTargetSchema }),
        output: CompanySchema
    },
    // The delete reports how many sessions went with the company (COMP-05).
    'companies:delete': {
        input: z.strictObject({ id: IdSchema }),
        output: z.strictObject({ deletedSessionCount: z.int().nonnegative() })
    },
    'settings:get': { input: z.void(), output: SettingsSchema },
    // Strict on write, lenient on read (WR-06).
    'settings:update': { input: SettingsSchema.extend({ scriptUrl: ScriptUrlSchema }).partial(), output: SettingsSchema }
} as const satisfies ContractMap;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]['output']>;
export type IpcApi = ApiOf<IpcContract>;
export type IpcHandlers = HandlersOf<IpcContract>;

// Main-to-renderer events; each entry arrives with the phase that designs the event (D-20).
export const ipcEvents = {} as const satisfies Readonly<Record<ChannelName, z.ZodType>>;
export type IpcEventChannel = keyof typeof ipcEvents;

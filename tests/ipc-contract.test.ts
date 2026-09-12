// SHARED-04..06 (D-16..D-20): one contract map, a day on the wire only as a validated LocalDate, types by inference.
// Type proofs sit in exported functions that never run; `npm run typecheck` enforces them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import { ipcContract } from '@shared/ipc/contract';
import type { ApiOf, ContractMap, HandlersOf, IpcApi, IpcChannel, IpcContract, IpcHandlers } from '@shared/ipc/contract';
import * as schemas from '@shared/schemas';
import { LocalDateSchema, SettingsSchema, WorkSessionSchema } from '@shared/schemas';
import type { Company, PomodoroSession, Settings, WorkSession } from '@shared/types';
import { isLocalDate } from '@shared/utils/date';
import type { LocalDate } from '@shared/utils/date';
import { findAll, read, repoRoot, stripCommentsAndStrings } from './helpers/ts-imports';

const CHANNELS = [
    'sessions:list', 'sessions:listByDateRange', 'sessions:listByDateAndCompany', 'sessions:create', 'sessions:update',
    'sessions:delete', 'sessions:deleteAll', 'companies:list', 'companies:get', 'companies:create', 'companies:update',
    'companies:delete', 'settings:get', 'settings:update'
];
const VOID_INPUT_CHANNELS = ['companies:list', 'sessions:list', 'settings:get'];
const EXPORTED_SCHEMAS = [
    'CompanySchema', 'DurationSecondsSchema', 'EpochMsSchema', 'IdSchema', 'LocalDateSchema', 'PomodoroSessionSchema',
    'SettingsSchema', 'WorkSessionSchema'
];

const isoOnTheWire: unknown = JSON.parse(JSON.stringify(new Date()));

const REJECTED_DAYS: [string, unknown][] = [
    ['a Date object', new Date()],
    ['the ISO string a Date becomes in JSON', isoOnTheWire],
    ['an unpadded month', '2026-9-10'],
    ['a day that does not exist', '2026-02-30'],
    ['a number', 20260910],
    ['null', null]
];

const WELL_FORMED_SESSION = {
    id: 1,
    name: 'Deep work',
    durationSeconds: 3600,
    date: '2026-09-10',
    companyId: null,
    note: null,
    createdAt: 1789000000000
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function defOf(schema: unknown, where: string): Record<string, unknown> {
    if (!isRecord(schema) || !isRecord(schema._zod) || !isRecord(schema._zod.def)) {
        throw new Error(where + ' is not a zod schema');
    }
    return schema._zod.def;
}

const CHILD_KEYS = ['shape', 'element', 'innerType', 'options', 'items', 'in', 'out', 'catchall', 'keyType', 'valueType'];
const BANNED_TYPES = new Set(['date', 'any', 'unknown', 'pipe', 'transform', 'default', 'prefault', 'catch']);
const CAMEL_CASE = /^[a-z][A-Za-z0-9]*$/;

// D-19's structural rule, over the schema tree zod itself builds.
function violations(root: unknown, label: string): string[] {
    const found: string[] = [];
    const seen = new Set<unknown>();
    const visit = (node: unknown, where: string): void => {
        if (seen.has(node)) return;
        seen.add(node);
        const def = defOf(node, where);
        const type = typeof def.type === 'string' ? def.type : '(untyped)';
        if (BANNED_TYPES.has(type)) found.push(where + ': ' + type);
        if (def.coerce === true) found.push(where + ': coerce');
        if (type === 'custom' && node !== LocalDateSchema) found.push(where + ': custom other than LocalDateSchema');
        for (const key of CHILD_KEYS) {
            const child = def[key];
            if (child === undefined) continue;
            if (key === 'shape') {
                if (!isRecord(child)) throw new Error(where + ': shape is not an object');
                for (const [name, value] of Object.entries(child)) {
                    if (!CAMEL_CASE.test(name)) found.push(where + ': shape key ' + name + ' is not camelCase');
                    visit(value, where + '.' + name);
                }
            } else if (Array.isArray(child)) {
                child.forEach((item: unknown, i) => visit(item, where + '.' + key + '[' + String(i) + ']'));
            } else {
                visit(child, where + '.' + key);
            }
        }
    };
    visit(root, label);
    return found;
}

// Every TypeScript file under src/shared that git knows, committed or not.
function sharedFiles(): string[] {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src/shared'], {
        cwd: repoRoot,
        encoding: 'utf8'
    })
        .split('\n')
        .map((line) => line.trim())
        .filter((file) => /\.tsx?$/.test(file) && fs.existsSync(path.join(repoRoot, file)));
}

const Z_MEMBERS = new Set(['date', 'coerce', 'any', 'unknown']);
const WRAPPER_CALLS = new Set(['transform', 'pipe', 'default', 'prefault', 'catch']);

const memberName = (node: ts.Node): string | undefined =>
    ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text
            : undefined;

function forbiddenZodUses(file: string, source: string): string[] {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const at = (node: ts.Node): string =>
        file + ':' + String(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1) + ' ';
    const found: string[] = [];
    const accesses = findAll(sourceFile, (n): n is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
        ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n));
    for (const access of accesses) {
        const name = memberName(access);
        if (name !== undefined && Z_MEMBERS.has(name) && ts.isIdentifier(access.expression) && access.expression.text === 'z') {
            found.push(at(access) + 'z.' + name);
        }
    }
    for (const call of findAll(sourceFile, (n): n is ts.CallExpression => ts.isCallExpression(n))) {
        const name = memberName(call.expression);
        if (name !== undefined && WRAPPER_CALLS.has(name)) found.push(at(call) + '.' + name + '()');
    }
    return found;
}

const SNAKE_CASE = /^[a-z]+(_[a-z]+)+$/;

const snakeCaseStrings = (file: string, source: string): string[] =>
    stripCommentsAndStrings(file, source).strings
        .filter((s) => SNAKE_CASE.test(s.value))
        .map((s) => file + ' ' + JSON.stringify(s.value));

function v121SettingSeeds(): Map<string, string> {
    const source = read('database/db.js');
    const start = source.indexOf('const defaultSettings = {');
    const end = source.indexOf('};', start);
    if (start < 0 || end < 0) throw new Error('database/db.js: the defaultSettings block moved; teach this test its shape');
    const seeds = new Map<string, string>();
    for (const [, key, value] of source.slice(start, end).matchAll(/^\s*([a-z_]+):\s*'([^']*)'/gm)) {
        if (key !== undefined && value !== undefined) seeds.set(key, value);
    }
    return seeds;
}

// [domain key, v1.2.1 seed key, default].
const SETTING_SEEDS: [keyof Settings, string, Settings[keyof Settings]][] = [
    ['dailyTargetSeconds', 'daily_target', 28800],
    ['goalNotification', 'goal_notification', true],
    ['excludeWeekendsFromStreak', 'exclude_weekends_from_streak', false],
    ['pomodoroEnabled', 'pomodoro_enabled', false],
    ['pomodoroWorkSeconds', 'pomodoro_work_duration', 1500],
    ['pomodoroShortBreakSeconds', 'pomodoro_short_break', 300],
    ['pomodoroLongBreakSeconds', 'pomodoro_long_break', 900],
    ['pomodoroSessionsUntilLongBreak', 'pomodoro_sessions_until_long_break', 4],
    ['pomodoroAutoStartBreaks', 'pomodoro_auto_start_breaks', true],
    ['pomodoroAutoStartWork', 'pomodoro_auto_start_work', false]
];
const UNREAD_SEEDS = ['haptic_feedback', 'start_reminder'];
// Seeded by v1.2.1, kept in the database, outside the v2 domain surface: the owner removed the export on 2026-09-11.
const RETIRED_SEEDS = ['export_half_hour_precision'];

describe('SHARED-04 / D-19: LocalDateSchema', () => {
    it('accepts a real local day, exactly as isLocalDate does', () => {
        expect(LocalDateSchema.safeParse('2026-09-10').success).toBe(true);
        expect(isLocalDate('2026-09-10'), 'the @shared alias resolved to a different date module').toBe(true);
    });

    it.each(REJECTED_DAYS)('rejects %s', (_label, value) => {
        expect(LocalDateSchema.safeParse(value).success, 'SHARED-04: a non-LocalDate day would reach the wire').toBe(false);
        expect(isLocalDate(value)).toBe(false);
    });
});

describe('D-16: the sessions channels validate through the contract map', () => {
    const range = ipcContract['sessions:listByDateRange'].input;

    it('rejects a Date where the contract expects a day', () => {
        expect(range.safeParse({ startDate: new Date(), endDate: '2026-09-10' }).success,
            'SHARED-04: a Date crossed the contract and would be JSON-serialised as a UTC instant').toBe(false);
        expect(range.safeParse({ startDate: '2026-09-01', endDate: '2026-09-10' }).success).toBe(true);
    });

    it('rejects an unknown key (strictObject)', () => {
        expect(range.safeParse({ startDate: '2026-09-01', endDate: '2026-09-10', extra: 1 }).success,
            'T-03-14: an object input accepted a key the contract does not declare').toBe(false);
    });

    it('WorkSessionSchema accepts a well-formed session and rejects a fractional duration', () => {
        expect(WorkSessionSchema.safeParse(WELL_FORMED_SESSION).success).toBe(true);
        expect(WorkSessionSchema.safeParse({ ...WELL_FORMED_SESSION, durationSeconds: 1.5 }).success,
            'D-19: durations are whole seconds').toBe(false);
    });
});

describe('D-16 / SHARED-05: the channel catalogue', () => {
    it('gives every channel an input and an output schema; the no-input channels say z.void() explicitly', () => {
        for (const [name, spec] of Object.entries(ipcContract)) {
            expect(isRecord(spec.input) && '_zod' in spec.input, 'SHARED-05: ' + name + ' has no input schema').toBe(true);
            expect(isRecord(spec.output) && '_zod' in spec.output, 'SHARED-05: ' + name + ' has no output schema').toBe(true);
        }
        const voidInputs = Object.entries(ipcContract)
            .filter(([name, spec]) => defOf(spec.input, name).type === 'void')
            .map(([name]) => name)
            .sort();
        expect(voidInputs, 'D-16: a channel without input must still declare z.void()').toEqual(VOID_INPUT_CHANNELS);
    });

    it('holds exactly the 14 proving channels, each named domain:action, none of them navigate', () => {
        const keys = Object.keys(ipcContract);
        expect([...keys].sort(), 'D-20: the proving catalogue changed').toEqual([...CHANNELS].sort());
        for (const key of keys) {
            expect(key, 'D-16: channel names are domain:action in camelCase').toMatch(/^[a-z]+:[a-z][A-Za-z]*$/);
            expect(key.toLowerCase(), 'S1 / T-03-16: a navigate channel reopens the path traversal').not.toContain('navigate');
        }
    });

    it('rejects unknown keys and invalid values on the companies and settings inputs', () => {
        const create = ipcContract['companies:create'].input;
        expect(create.safeParse({ name: 'Acme', noteRequired: false }).success).toBe(true);
        expect(create.safeParse({ name: 'Acme', noteRequired: false, excelColumn: 'B' }).success,
            'T-03-14: companies:create accepted an undeclared key').toBe(false);
        const company = ipcContract['companies:update'].input;
        expect(company.safeParse({ id: 1, name: 'Acme', noteRequired: false }).success).toBe(true);
        expect(company.safeParse({ id: 1, name: 'Acme', noteRequired: false, sheets: { excelColumn: 'B', noteColumn: 'C' } })
            .success, 'SC4: companies:update accepted a sheets target the contract no longer declares').toBe(false);
        const update = ipcContract['settings:update'].input;
        expect(update.safeParse({}).success).toBe(true);
        expect(update.safeParse({ pomodoroEnabled: true }).success).toBe(true);
        expect(update.safeParse({ unknownKey: 1 }).success, 'T-03-14: settings:update accepted an unknown key').toBe(false);
        expect(update.safeParse({ dailyTargetSeconds: 0 }).success, 'D-19: a zero daily target was accepted').toBe(false);
    });
});

describe('WR-05: sessions:deleteAll cannot erase every session by accident', () => {
    const { input, output } = ipcContract['sessions:deleteAll'];

    it('demands the exact confirmation literal and nothing else', () => {
        expect(input.safeParse({ confirm: 'DELETE_ALL_SESSIONS' }).success).toBe(true);
        const refused: unknown[] = [
            undefined, {}, { confirm: 'yes' }, { confirm: 'delete_all_sessions' }, { confirm: true },
            { confirm: 'DELETE_ALL_SESSIONS', extra: 1 }
        ];
        for (const value of refused) {
            expect(input.safeParse(value).success, 'WR-05: deleteAll accepted ' + String(JSON.stringify(value))).toBe(false);
        }
    });

    it('reports a whole, non-negative count of deleted sessions', () => {
        expect(output.safeParse({ deletedSessionCount: 3 }).success).toBe(true);
        for (const value of [undefined, {}, { deletedSessionCount: -1 }, { deletedSessionCount: 1.5 }] as unknown[]) {
            expect(output.safeParse(value).success, 'WR-05: deleteAll reported ' + String(JSON.stringify(value))).toBe(false);
        }
    });
});

// Replaces the WR-06 scriptUrl-validation block: with the export gone there is nowhere to send anything, so what
// still bites is the other direction - neither removed setting can re-enter through the wire in either direction.
describe('SC4: the settings the export took with it cannot cross the contract', () => {
    const REMOVED: [string, unknown][] = [
        ['scriptUrl', 'https://script.google.com/macros/s/AKfycbx0/exec'],
        ['exportHalfHourPrecision', true]
    ];

    it('carries the ten settings the app kept', () => {
        expect(ipcContract['settings:get'].output.safeParse(DEFAULT_SETTINGS).success).toBe(true);
        expect(ipcContract['settings:update'].input.safeParse(DEFAULT_SETTINGS).success).toBe(true);
    });

    it.each(REMOVED)('settings:update refuses to write %s', (key, value) => {
        expect(ipcContract['settings:update'].input.safeParse({ [key]: value }).success,
            'SC4: settings:update accepted ' + key + ', so the removed export setting is writable again').toBe(false);
    });

    it.each(REMOVED)('settings:get refuses to report %s', (key, value) => {
        expect(ipcContract['settings:get'].output.safeParse({ ...DEFAULT_SETTINGS, [key]: value }).success,
            'SC4: settings:get carried ' + key + ' back to the renderer').toBe(false);
    });
});

describe('D-19: no date, coercion, catch-all, transform or default anywhere in the shared schemas', () => {
    it('the walk finds every banned construct in a probe schema (negative control)', () => {
        const probe = z.object({
            coerced: z.coerce.string(),
            instant: z.date(),
            defaulted: z.string().default(''),
            transformed: z.string().transform((s) => s.length),
            loose: z.unknown(),
            anything: z.any(),
            otherCustom: z.custom<string>(),
            prefaulted: z.string().prefault(''),
            caught: z.string().catch(''),
            snake_key: z.string()
        });
        expect(violations(probe, 'probe')).toEqual(expect.arrayContaining([
            'probe.coerced: coerce', 'probe.instant: date', 'probe.defaulted: default', 'probe.transformed: pipe',
            'probe.loose: unknown', 'probe.anything: any', 'probe.otherCustom: custom other than LocalDateSchema',
            'probe.prefaulted: prefault', 'probe.caught: catch', 'probe: shape key snake_key is not camelCase'
        ]));
    });

    it('finds nothing in any exported schema or any contract input or output', () => {
        const exported = Object.entries(schemas);
        expect(exported.map(([name]) => name).sort()).toEqual(expect.arrayContaining(EXPORTED_SCHEMAS));
        const roots: [string, unknown][] = [
            ...exported,
            ...Object.entries(ipcContract).flatMap(([name, spec]): [string, unknown][] =>
                [[name + '.input', spec.input], [name + '.output', spec.output]])
        ];
        expect(roots.length).toBe(exported.length + 2 * CHANNELS.length);
        expect(roots.flatMap(([label, schema]) => violations(schema, label)),
            'D-19: a shared schema can coerce, default or transform, so z.input and z.output diverge or a Date slips through')
            .toEqual([]);
    });

    it('the source scan finds every banned zod call form (negative control)', () => {
        const sample = [
            'const a = z.date();', 'const b = z.coerce.string();', "const c = z['any']();", 'const d = z.unknown();',
            'const e = s.transform(f);', 'const f = s.pipe(t);', 'const g = s.default(1);', 'const h = s.prefault(1);',
            'const i = s.catch(1);', 'const j = z.string();'
        ].join('\n');
        expect(forbiddenZodUses('src/shared/sample.ts', sample)).toEqual([
            'src/shared/sample.ts:1 z.date', 'src/shared/sample.ts:2 z.coerce', 'src/shared/sample.ts:3 z.any',
            'src/shared/sample.ts:4 z.unknown', 'src/shared/sample.ts:5 .transform()', 'src/shared/sample.ts:6 .pipe()',
            'src/shared/sample.ts:7 .default()', 'src/shared/sample.ts:8 .prefault()', 'src/shared/sample.ts:9 .catch()'
        ]);
    });

    it('no git-known src/shared file uses a banned zod form', () => {
        const files = sharedFiles();
        expect(files, 'the scan cannot see the files it guards').toEqual(expect.arrayContaining([
            'src/shared/schemas/index.ts', 'src/shared/ipc/contract.ts', 'src/shared/types/index.ts',
            'src/shared/constants/settings.ts', 'src/shared/utils/date.ts'
        ]));
        expect(files.flatMap((file) => forbiddenZodUses(file, read(file))), 'D-19: banned zod construct in src/shared').toEqual([]);
    });

    it('no string literal in src/shared is a snake_case key (CORE-01, D-20)', () => {
        expect(snakeCaseStrings('src/shared/sample.ts', "const k = 'daily_target'; // 'goal_notification'"),
            'negative control: the scan no longer finds a snake_case literal').toEqual(['src/shared/sample.ts "daily_target"']);
        expect(sharedFiles().flatMap((file) => snakeCaseStrings(file, read(file))),
            'D-20: legacy column and setting names belong to the Phase 5 repository mapper, not src/shared').toEqual([]);
    });
});

describe('D-20: DEFAULT_SETTINGS mirrors v1.2.1', () => {
    const seeds = v121SettingSeeds();

    it('parses under SettingsSchema, holds exactly its 10 keys, and is frozen', () => {
        expect(() => SettingsSchema.parse(DEFAULT_SETTINGS)).not.toThrow();
        const schemaKeys = Object.keys(SettingsSchema.shape).sort();
        expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(schemaKeys);
        expect(schemaKeys).toHaveLength(10);
        expect(Object.isFrozen(DEFAULT_SETTINGS), 'D-20: a caller could rewrite the shared defaults').toBe(true);
    });

    it('accounts for every v1.2.1 seed: mapped to a domain key, never read, or retired with the export', () => {
        const mapped = SETTING_SEEDS.map(([, seed]) => seed);
        expect([...seeds.keys()].sort()).toEqual([...mapped, ...UNREAD_SEEDS, ...RETIRED_SEEDS].sort());
        expect(SETTING_SEEDS.map(([key]) => key).sort()).toEqual(Object.keys(SettingsSchema.shape).sort());
    });

    it.each(SETTING_SEEDS)('%s defaults to the v1.2.1 seed %s', (key, seed, expected) => {
        expect(DEFAULT_SETTINGS[key]).toBe(expected);
        expect(seeds.get(seed), 'D-20: the default drifted from database/db.js').toBe(String(expected));
    });
});

export function tracerTypeProofs(api: IpcApi, day: LocalDate): void {
    // @ts-expect-error a Date is not a LocalDate
    void api['sessions:listByDateRange']({ startDate: new Date(), endDate: day });
    // @ts-expect-error every channel needs a handler
    const none: IpcHandlers = {};
    void none;
}

export function contractTypeProofs(api: IpcApi, handlers: IpcHandlers, day: LocalDate): void {
    // @ts-expect-error a handler must return the contract's output
    const wrongOutput: IpcHandlers['companies:list'] = () => [{ id: 'one' }];
    const unknownHandled: Pick<IpcHandlers, 'sessions:deleteAll'> = {
        'sessions:deleteAll': () => ({ deletedSessionCount: 0 }),
        // @ts-expect-error navigate is not a channel
        navigate: () => undefined
    };
    // @ts-expect-error WR-05: deleteAll must report how many sessions it removed
    const silentDeleteAll: IpcHandlers['sessions:deleteAll'] = () => undefined;
    // @ts-expect-error WR-05: deleteAll cannot be called without its confirmation
    void api['sessions:deleteAll']();
    // @ts-expect-error WR-05: only the exact confirmation literal is accepted
    void api['sessions:deleteAll']({ confirm: 'yes' });
    void api['sessions:deleteAll']({ confirm: 'DELETE_ALL_SESSIONS' });
    void silentDeleteAll;
    // @ts-expect-error navigate is not a channel
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- the call is the proof; it must not compile
    void api['navigate']();
    // @ts-expect-error a Date is not a LocalDate
    void api['sessions:listByDateAndCompany']({ date: new Date(), companyId: 1 });
    // @ts-expect-error a plain string is not a LocalDate
    void api['sessions:listByDateAndCompany']({ date: '2026-09-10', companyId: 1 });
    // @ts-expect-error a void-input channel takes no argument
    void api['companies:list'](1);
    void api['companies:list']();
    void api['sessions:listByDateAndCompany']({ date: day, companyId: 1 });

    const reject = (): Promise<never> => Promise.reject(new Error('type proof only'));
    const all: IpcHandlers = {
        'sessions:list': reject,
        'sessions:listByDateRange': reject,
        'sessions:listByDateAndCompany': reject,
        'sessions:create': reject,
        'sessions:update': reject,
        'sessions:delete': reject,
        'sessions:deleteAll': reject,
        'companies:list': reject,
        'companies:get': reject,
        'companies:create': reject,
        'companies:update': reject,
        'companies:delete': reject,
        'settings:get': reject,
        'settings:update': reject
    };
    void wrongOutput;
    void unknownHandled;
    void handlers;
    void all;
}

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Symmetric<S extends z.ZodType> = Eq<z.input<S>, z.output<S>>;
type AsymmetricChannel = {
    [C in IpcChannel]: Symmetric<IpcContract[C]['input']> extends true
        ? Symmetric<IpcContract[C]['output']> extends true ? never : C
        : C;
}[IpcChannel];

export function inferenceProofs(): void {
    const localDateInferred: Eq<z.infer<typeof LocalDateSchema>, LocalDate> = true;
    const noAsymmetricChannel: Eq<AsymmetricChannel, never> = true;
    const domainTypesInferred: [
        Eq<Company, z.output<typeof schemas.CompanySchema>>,
        Eq<WorkSession, z.output<typeof schemas.WorkSessionSchema>>,
        Eq<PomodoroSession, z.output<typeof schemas.PomodoroSessionSchema>>,
        Eq<Settings, z.output<typeof schemas.SettingsSchema>>
    ] = [true, true, true, true];
    const domainSchemasSymmetric: [
        Symmetric<typeof schemas.CompanySchema>,
        Symmetric<typeof schemas.WorkSessionSchema>,
        Symmetric<typeof schemas.PomodoroSessionSchema>,
        Symmetric<typeof schemas.SettingsSchema>
    ] = [true, true, true, true];
    void localDateInferred;
    void noAsymmetricChannel;
    void domainTypesInferred;
    void domainSchemasSymmetric;
}

// SC3 on a contract of the test's own: one added entry appears at both ends.
export const localContract = {
    'probe:one': { input: z.void(), output: z.string() },
    'probe:two': { input: z.strictObject({ day: LocalDateSchema }), output: z.void() }
} as const satisfies ContractMap;

export function localContractProofs(api: ApiOf<typeof localContract>, day: LocalDate): void {
    void api['probe:one']();
    void api['probe:two']({ day });
    // @ts-expect-error every entry of the local contract needs a handler
    const partial: HandlersOf<typeof localContract> = { 'probe:one': () => 'one' };
    const noColon = {
        // @ts-expect-error a channel name needs its domain:action colon
        probeThree: { input: z.void(), output: z.void() }
    } as const satisfies ContractMap;
    void partial;
    void noColon;
}

// Criterion 7: a malformed payload is refused by the channel's schema, in main, BEFORE any service runs - proved with
// services that record every call and are asserted never to have been reached. And the shape of a handler itself:
// validate (done in dispatch), one service call, the answer. Nothing branches here.

import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { ipcContract } from '../src/shared/ipc/contract';
import { IPC_CHANNELS } from '../src/shared/ipc/channels';
import { createDispatch } from '../src/main/ipc/dispatch';
import { createHandlers } from '../src/main/ipc/handlers';
import { INTERNAL_MESSAGE, MAX_ERROR_MESSAGE_LENGTH, invalidInputError, toIpcError } from '../src/main/ipc/errors';
import { ServiceError, conflict, invalidInput, notFound } from '../src/main/services/service-errors';
import { SettingsValidationError } from '../src/main/services/settings.service';
import { DEFAULT_SETTINGS } from '../src/shared/constants/settings';
import {
    MAX_SESSION_DURATION_SECONDS, MAX_SESSION_NAME_LENGTH, MAX_SESSION_NOTE_LENGTH
} from '../src/shared/constants/sessions';
import { findAll, read } from './helpers/ts-imports';
import type { HandlerContext } from '../src/main/ipc/handlers';
import type { IpcChannel, IpcHandlers, LocalDate, Settings } from '../src/shared/types';

// Criterion 3: this suite must pass with electron refusing to load.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

const HANDLERS_FILE = 'src/main/ipc/handlers.ts';
const DAY = '2026-09-12' as LocalDate;

const COMPANY = { id: 7, name: 'Contoso', noteRequired: false, createdAt: 1789000000000 };
const SESSION = {
    id: 3, name: 'Deep work', durationSeconds: 1800, date: DAY, companyId: 7, note: null, createdAt: 1789000000000
};
const TIMER = { status: 'idle', mode: 'work', elapsedSeconds: 0, restoredFromPreviousLaunch: false } as const;
const POMODORO = {
    interval: 'work', status: 'idle', elapsedSeconds: 0, targetSeconds: 1500, remainingSeconds: 1500,
    date: DAY, completedToday: 0, sessionsUntilLongBreak: 4
} as const;

interface Spy {
    readonly calls: string[];
    readonly context: HandlerContext;
    /** Makes the next call to `method` throw, so the failure paths are exercised through the real dispatch. */
    fail(method: string, error: Error): void;
}

function spyingServices(): Spy {
    const calls: string[] = [];
    const failures = new Map<string, Error>();

    // Every service method is this: it records that it was reached, then answers with a fixed value.
    const answer = <T>(method: string, value: T) => (): T => {
        calls.push(method);
        const failure = failures.get(method);
        if (failure !== undefined) {
            failures.delete(method);
            throw failure;
        }
        return value;
    };

    const context: HandlerContext = {
        sessions: {
            list: answer('sessions.list', [SESSION]),
            listByDateRange: answer('sessions.listByDateRange', [SESSION]),
            listByDateAndCompany: answer('sessions.listByDateAndCompany', [SESSION]),
            create: answer('sessions.create', SESSION),
            update: answer('sessions.update', SESSION),
            remove: answer('sessions.remove', undefined),
            removeAll: answer('sessions.removeAll', 4)
        },
        companies: {
            list: answer('companies.list', [COMPANY]),
            get: answer('companies.get', COMPANY),
            create: answer('companies.create', COMPANY),
            update: answer('companies.update', COMPANY),
            remove: answer('companies.remove', { deletedSessionCount: 2 })
        },
        settings: {
            get: answer('settings.get', DEFAULT_SETTINGS),
            update: answer('settings.update', DEFAULT_SETTINGS)
        },
        timer: {
            snapshot: answer('timer.snapshot', TIMER),
            start: answer('timer.start', TIMER),
            pause: answer('timer.pause', TIMER),
            reset: answer('timer.reset', TIMER),
            setMode: answer('timer.setMode', TIMER),
            suspend: answer('timer.suspend', undefined),
            resume: answer('timer.resume', undefined),
            persistNow: answer('timer.persistNow', true),
            dispose: answer('timer.dispose', undefined)
        },
        pomodoro: {
            snapshot: answer('pomodoro.snapshot', POMODORO),
            start: answer('pomodoro.start', POMODORO),
            pause: answer('pomodoro.pause', POMODORO),
            abort: answer('pomodoro.abort', POMODORO),
            skipBreak: answer('pomodoro.skipBreak', POMODORO),
            tick: answer('pomodoro.tick', POMODORO),
            dispose: answer('pomodoro.dispose', undefined)
        },
        stats: {
            dayProgress: answer('stats.dayProgress',
                { date: DAY, totalSeconds: 3600, dailyTargetSeconds: 28800, goalMet: false }),
            today: answer('stats.today', { date: DAY, totalSeconds: 3600, dailyTargetSeconds: 28800, goalMet: false }),
            streak: answer('stats.streak', { date: DAY, days: 3 }),
            weeks: answer('stats.weeks', { thisWeekSeconds: 7200, lastWeekSeconds: 3600 }),
            pomodoroCounts: answer('stats.pomodoroCounts', { date: DAY, todayCount: 2, thisWeekCount: 9 })
        },
        window: {
            minimize: answer('window.minimize', undefined),
            close: answer('window.close', undefined)
        }
    };

    return { calls, context, fail: (method, error) => { failures.set(method, error); } };
}

interface Harness extends Spy {
    readonly logs: string[];
    call(channel: IpcChannel, input?: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
}

function harness(): Harness {
    const spy = spyingServices();
    const logs: string[] = [];
    const dispatch = createDispatch({ handlers: () => createHandlers(spy.context), log: (line) => logs.push(line) });
    return { ...spy, logs, call: (channel, input) => dispatch(channel, input) };
}

// One valid payload and the one service call it must produce, per channel.
const WELL_FORMED: Readonly<Record<IpcChannel, { input?: unknown; reaches: string }>> = {
    'sessions:list': { reaches: 'sessions.list' },
    'sessions:listByDateRange': { input: { startDate: DAY, endDate: DAY }, reaches: 'sessions.listByDateRange' },
    'sessions:listByDateAndCompany': { input: { date: DAY, companyId: 7 }, reaches: 'sessions.listByDateAndCompany' },
    'sessions:create': {
        input: { name: 'Deep work', durationSeconds: 1800, date: DAY, companyId: 7, note: null },
        reaches: 'sessions.create'
    },
    'sessions:update': {
        input: { id: 3, name: 'Deep work', durationSeconds: 1800, date: DAY, companyId: 7, note: null },
        reaches: 'sessions.update'
    },
    'sessions:delete': { input: { id: 3 }, reaches: 'sessions.remove' },
    'sessions:deleteAll': { input: { confirm: 'DELETE_ALL_SESSIONS' }, reaches: 'sessions.removeAll' },
    'companies:list': { reaches: 'companies.list' },
    'companies:get': { input: { id: 7 }, reaches: 'companies.get' },
    'companies:create': { input: { name: 'Contoso', noteRequired: false }, reaches: 'companies.create' },
    'companies:update': { input: { id: 7, name: 'Contoso', noteRequired: true }, reaches: 'companies.update' },
    'companies:delete': { input: { id: 7 }, reaches: 'companies.remove' },
    'settings:get': { reaches: 'settings.get' },
    'settings:update': { input: { pomodoroEnabled: true }, reaches: 'settings.update' },
    'timer:getSnapshot': { reaches: 'timer.snapshot' },
    'timer:start': { reaches: 'timer.start' },
    'timer:pause': { reaches: 'timer.pause' },
    'timer:reset': { reaches: 'timer.reset' },
    'timer:setMode': { input: { mode: 'pomodoro' }, reaches: 'timer.setMode' },
    'pomodoro:getSnapshot': { reaches: 'pomodoro.snapshot' },
    'pomodoro:start': { reaches: 'pomodoro.start' },
    'pomodoro:pause': { reaches: 'pomodoro.pause' },
    'pomodoro:abort': { reaches: 'pomodoro.abort' },
    'pomodoro:skipBreak': { reaches: 'pomodoro.skipBreak' },
    'pomodoro:counts': { reaches: 'stats.pomodoroCounts' },
    'stats:streak': { reaches: 'stats.streak' },
    'stats:weekTotals': { reaches: 'stats.weeks' },
    'stats:dayProgress': { input: { date: DAY }, reaches: 'stats.dayProgress' },
    'window:minimize': { reaches: 'window.minimize' },
    'window:close': { reaches: 'window.close' }
};

// Refused by every channel: a void input rejects an object, and every object input is strict.
const MALFORMED: [string, unknown][] = [
    ['an object of undeclared keys', { hasNoBusinessHere: true }],
    ['a string', 'DROP TABLE work_sessions'],
    ['an array', [1, 2, 3]]
];

describe('IPC-02: every channel the contract declares has exactly one handler', () => {
    it('answers on the contract\'s channels and on nothing else', () => {
        const handled = Object.keys(createHandlers(spyingServices().context)).sort();
        expect(handled).toEqual(Object.keys(ipcContract).sort());
        expect(handled).toEqual([...IPC_CHANNELS].sort());
    });

    it.each(Object.keys(WELL_FORMED) as IpcChannel[])('%s reaches exactly one service call', async (channel) => {
        const h = harness();
        const result = await h.call(channel, WELL_FORMED[channel].input);
        expect(result.ok, channel + ' refused a payload its own schema accepts: ' + JSON.stringify(result)).toBe(true);
        expect(h.calls, channel + ' did not make exactly one service call').toEqual([WELL_FORMED[channel].reaches]);
    });

    it('returns what the contract says it returns, validated against the output schema', async () => {
        const h = harness();
        for (const channel of Object.keys(WELL_FORMED) as IpcChannel[]) {
            const result = await h.call(channel, WELL_FORMED[channel].input);
            const parsed = ipcContract[channel].output.safeParse(result.data);
            expect(parsed.success, channel + ' answered something its output schema rejects').toBe(true);
        }
    });
});

describe('criterion 7: a malformed payload is refused before any service runs', () => {
    it.each(MALFORMED)('every channel refuses %s, and no service is reached', async (_label, payload) => {
        const h = harness();
        for (const channel of IPC_CHANNELS) {
            const result = await h.call(channel, payload);
            expect(result.ok, channel + ' accepted ' + JSON.stringify(payload)).toBe(false);
            expect(result.error?.code).toBe('INVALID_INPUT');
        }
        expect(h.calls, 'a service ran on a payload the contract refuses:\n  ' + h.calls.join('\n  ')).toEqual([]);
    });

    it('refuses a Date where a day belongs, and a missing confirmation on deleteAll', async () => {
        const h = harness();
        const day = await h.call('stats:dayProgress', { date: new Date() });
        const all = await h.call('sessions:deleteAll', { confirm: 'yes' });
        expect(day.ok, 'SHARED-04: a Date crossed the wire as a day').toBe(false);
        expect(all.ok, 'WR-05: deleteAll ran without its confirmation literal').toBe(false);
        expect(h.calls).toEqual([]);
    });

    it('names the field it refused and quotes no value back', async () => {
        const h = harness();
        const result = await h.call('sessions:create', {
            name: 'Client X quarterly review', durationSeconds: -5, date: DAY, companyId: null, note: 'private note'
        });
        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain('durationSeconds');
        expect(result.error?.message, 'the refusal quoted user content back to the caller')
            .not.toContain('private note');
        expect(result.error?.message).not.toContain('Client X');
        expect(h.calls).toEqual([]);
    });

    it('refuses an extra key on an otherwise valid payload (strictObject)', async () => {
        const h = harness();
        const result = await h.call('companies:create', { name: 'Contoso', noteRequired: false, excelColumn: 'B' });
        expect(result.ok, 'T-03-14: an undeclared key reached a service').toBe(false);
        expect(h.calls).toEqual([]);
    });
});

describe('D-17: what a failure carries back', () => {
    it('keeps a service refusal\'s own code and words', async () => {
        const cases: [Error, string][] = [
            [notFound('that session does not exist.'), 'NOT_FOUND'],
            [invalidInput('Contoso requires a note on every session.'), 'INVALID_INPUT'],
            [conflict('A company called Contoso already exists.'), 'CONFLICT'],
            [new SettingsValidationError('dailyTargetSeconds', 'settings: out of range.'), 'INVALID_INPUT']
        ];
        for (const [error, code] of cases) {
            const h = harness();
            h.fail('sessions.remove', error);
            const result = await h.call('sessions:delete', { id: 3 });
            expect(result.ok).toBe(false);
            expect(result.error?.code).toBe(code);
            expect(result.error?.message).toBe(error.message);
        }
    });

    it('tells the renderer nothing about an accident, and logs it in main instead', async () => {
        const h = harness();
        const boom = new Error('SQLITE_CORRUPT: database disk image is malformed at C:\\Users\\someone\\krono.db');
        h.fail('companies.list', boom);
        const result = await h.call('companies:list');

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('INTERNAL');
        expect(result.error?.message).toBe(INTERNAL_MESSAGE);
        expect(JSON.stringify(result), 'a driver message crossed the wire').not.toContain('SQLITE_CORRUPT');
        expect(JSON.stringify(result), 'a filesystem path crossed the wire').not.toContain('krono.db');
        expect(h.logs.join('\n'), 'the reason was not recorded anywhere').toContain('SQLITE_CORRUPT');
    });

    it('never carries a stack, and clips a long refusal', () => {
        const withStack = new ServiceError('NOT_FOUND', 'gone');
        expect(Object.keys(toIpcError(withStack))).toEqual(['code', 'message']);
        expect(JSON.stringify(toIpcError(withStack))).not.toContain('at Object');

        const long = toIpcError(new ServiceError('INVALID_INPUT', 'x'.repeat(MAX_ERROR_MESSAGE_LENGTH * 2)));
        expect(long.message.length).toBe(MAX_ERROR_MESSAGE_LENGTH);

        const clipped = invalidInputError('sessions:create', [{ path: ['note'], message: 'y'.repeat(500) }]);
        expect(clipped.message.length).toBe(MAX_ERROR_MESSAGE_LENGTH);
        expect(clipped.code).toBe('INVALID_INPUT');
    });

    it('reports a container that is not there yet as INTERNAL rather than throwing out of the handler', async () => {
        const logs: string[] = [];
        const dispatch = createDispatch({
            handlers: () => { throw new Error('no container is active; the database is not open'); },
            log: (line) => logs.push(line)
        });
        const result = await dispatch('companies:list', undefined);
        expect(result).toEqual({ ok: false, error: { code: 'INTERNAL', message: INTERNAL_MESSAGE } });
        expect(logs.join('\n')).toContain('no container is active');
    });
});

/*
 * The structural half of criterion 7. A handler that grows an if, a loop or a ternary has taken a decision that
 * belongs to a service - and it would be taken where nothing unit-tests it, because the service tests cannot see it
 * and the IPC tests are about the wire.
 */
describe('criterion 7: no handler body branches', () => {
    const source = ts.createSourceFile(HANDLERS_FILE, read(HANDLERS_FILE), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const handlerBodies = (): { channel: string; body: ts.Node }[] => {
        const [returned] = findAll(source, (node): node is ts.ObjectLiteralExpression =>
            ts.isObjectLiteralExpression(node) && node.properties.length > 5);
        expect(returned, HANDLERS_FILE + ': the handler map moved; teach this test its shape').toBeDefined();
        return (returned?.properties ?? []).flatMap((property) => {
            if (!ts.isPropertyAssignment(property) || !ts.isArrowFunction(property.initializer)) return [];
            const channel = ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(source);
            return [{ channel, body: property.initializer.body }];
        });
    };

    const BRANCHES = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.IfStatement, ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.SwitchStatement,
        ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement,
        ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.TryStatement,
        ts.SyntaxKind.CatchClause
    ]);
    const BRANCHING_OPERATORS = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken
    ]);

    it('finds one arrow-function body per channel, so the checks below are not vacuous', () => {
        expect(handlerBodies().map((h) => h.channel).sort()).toEqual([...IPC_CHANNELS].sort());
    });

    it.each(handlerBodies())('$channel is one call, with no branch in it', ({ channel, body }) => {
        const branches = findAll(body, (node): node is ts.Node =>
            BRANCHES.has(node.kind) ||
            (ts.isBinaryExpression(node) && BRANCHING_OPERATORS.has(node.operatorToken.kind)));
        expect(branches.map((node) => ts.SyntaxKind[node.kind]),
            channel + ' branches; that decision belongs to the service it calls').toEqual([]);

        const calls = findAll(body, (node): node is ts.CallExpression => ts.isCallExpression(node));
        expect(calls.length, channel + ' makes ' + String(calls.length) + ' calls, not one').toBe(1);
    });
});

/*
 * WR-05: the contract declares an output schema for all 30 channels and main parsed none of them, so a service that
 * answered something the contract does not describe crossed to the renderer unchallenged. In development it is
 * parsed, and a failure is shaped like any other failure in main rather than becoming the renderer's problem.
 */
describe('WR-05: an answer the contract does not describe', () => {
    const wrong = (): IpcHandlers => ({
        ...createHandlers(spyingServices().context),
        'settings:get': () => ({ dailyTargetSeconds: 'eight hours' }) as unknown as Settings
    });

    it('is refused in development, as INTERNAL, with the reason left in main', async () => {
        const lines: string[] = [];
        const dispatch = createDispatch({ handlers: wrong, log: (line) => lines.push(line), checkOutput: true });

        expect(await dispatch('settings:get', undefined))
            .toEqual({ ok: false, error: { code: 'INTERNAL', message: INTERNAL_MESSAGE } });
        expect(lines.join('\n'), 'the reason was not written down anywhere')
            .toContain('answered something the contract does not describe');
    });

    it('is not parsed when the check is off, which is what a packaged app runs', async () => {
        const dispatch = createDispatch({ handlers: wrong, log: () => undefined });
        expect((await dispatch('settings:get', undefined)).ok).toBe(true);
    });
});

/*
 * WR-07: sessions:create accepted a durationSeconds of 1 099 511 627 776 and a name of nothing at all, while every
 * settings number was argued over and bounded. The renderer is the only caller today; a date-picker or a duration
 * slip on a later screen is exactly the class of defect a boundary exists to make impossible.
 */
describe('WR-07: what a session payload may say', () => {
    const VALID = { name: 'Deep work', durationSeconds: 1800, date: DAY, companyId: null, note: null };

    const refused: [string, unknown][] = [
        ['a duration no day could hold', { ...VALID, durationSeconds: 1_099_511_627_776 }],
        ['a duration one second past a day', { ...VALID, durationSeconds: MAX_SESSION_DURATION_SECONDS + 1 }],
        ['a negative duration', { ...VALID, durationSeconds: -1 }],
        ['no name at all', { ...VALID, name: '' }],
        ['a name of nothing but spaces', { ...VALID, name: '   ' }],
        ['a name past the cap', { ...VALID, name: 'n'.repeat(MAX_SESSION_NAME_LENGTH + 1) }],
        ['a note past the cap', { ...VALID, note: 'x'.repeat(MAX_SESSION_NOTE_LENGTH + 1) }]
    ];

    it.each(refused)('refuses %s, as a typed IpcError, before the service runs', async (_why, input) => {
        const h = harness();
        const answer = await h.call('sessions:create', input);
        expect(answer.ok).toBe(false);
        expect(answer.error?.code).toBe('INVALID_INPUT');
        expect(answer.error?.message.length).toBeGreaterThan(0);
        expect(h.calls, 'the session reached the service anyway').toEqual([]);
    });

    it('refuses the same on an update, which writes the same row', async () => {
        const h = harness();
        const answer = await h.call('sessions:update', { id: 3, ...VALID, durationSeconds: 1_099_511_627_776 });
        expect(answer.error?.code).toBe('INVALID_INPUT');
        expect(h.calls).toEqual([]);
    });

    it('accepts a whole day and a name at the cap, which are the largest honest values', async () => {
        const h = harness();
        const answer = await h.call('sessions:create', {
            ...VALID,
            durationSeconds: MAX_SESSION_DURATION_SECONDS,
            name: 'n'.repeat(MAX_SESSION_NAME_LENGTH),
            note: 'x'.repeat(MAX_SESSION_NOTE_LENGTH)
        });
        expect(answer.ok, 'the cap refused the value it is meant to allow').toBe(true);
        expect(h.calls).toEqual(['sessions.create']);
    });

    it('refuses a date range that runs backwards rather than answering an empty history', async () => {
        const h = harness();
        const answer = await h.call('sessions:listByDateRange', { startDate: '2026-12-31', endDate: '2020-01-01' });
        expect(answer.error?.code).toBe('INVALID_INPUT');
        expect(h.calls).toEqual([]);

        const sameDay = harness();
        expect((await sameDay.call('sessions:listByDateRange', { startDate: DAY, endDate: DAY })).ok,
            'a single day is not a reversed range').toBe(true);
    });
});

/** IN-01: what a refusal really says, pinned - because the comment above invalidInputError once claimed more. */
describe('IN-01: an unrecognised key comes back by name', () => {
    it('names the key the caller sent, and nothing it was sent with', async () => {
        const h = harness();
        const answer = await h.call('settings:update', { dailyTargetSeconds: 3600, sideChannel: 'a value of mine' });

        expect(answer.error?.code).toBe('INVALID_INPUT');
        expect(answer.error?.message, 'the key the caller supplied is named, which is the IN-01 correction')
            .toContain('sideChannel');
        expect(answer.error?.message, 'the value it carried must never cross').not.toContain('a value of mine');
        expect(h.calls, 'a refused payload reached the service').toEqual([]);
    });
});

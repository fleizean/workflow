// D-37: the packaged smoke's verdicts are pure functions of what was observed, so every case is judged here in
// milliseconds rather than only inside a 90-second Electron launch. The launches themselves supply the inputs.

import { describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../src/main/config';
import {
    EXPECTED_EXIT_CODES, evaluateRefusalCase, evaluateTimerCase, evaluateWalFlushed
} from '../tools/smoke-packaged.mjs';
import type { SmokeCheck, SmokeReport } from '../tools/smoke-packaged.mjs';

const NEWER_HASH = 'f'.repeat(64);

const reportOf = (fields: Record<string, string>): SmokeReport => ({ ok: false, fields });

const failed = (checks: readonly SmokeCheck[]): string[] =>
    checks.filter((check) => !check.pass).map((check) => check.label);

const refusal = {
    exit: { code: EXIT_CODES.refusedNewer, signal: null, timedOut: false },
    report: reportOf({ SMOKE_REPORT_KIND: 'refused', SMOKE_REPORT_TITLE: 'Workflow will not open this database' }),
    hashBefore: NEWER_HASH,
    hashAfter: NEWER_HASH,
    smokeDbExists: false
};

describe('D-30/D-37: a newer database is refused in the packaged app without a window or a write', () => {
    it('passes on the refusal the bootstrap is supposed to produce', () => {
        expect(failed(evaluateRefusalCase(refusal))).toEqual([]);
    });

    const DEVIATIONS: [string, Partial<typeof refusal>][] = [
        ['the app exited 0 instead of the refusal code', { exit: { code: 0, signal: null, timedOut: false } }],
        ['the app exited with the wrong refusal code', {
            exit: { code: EXIT_CODES.refusedUnrecognized, signal: null, timedOut: false }
        }],
        ['no refusal was reported', { report: reportOf({}) }],
        ['a door refusal was reported instead', { report: reportOf({ SMOKE_REPORT_KIND: 'door' }) }],
        ['a window was created', {
            report: reportOf({ SMOKE_REPORT_KIND: 'refused', SMOKE_WINDOW_CREATED: 'true' })
        }],
        ['the file was changed', { hashAfter: '0'.repeat(64) }],
        ['a smoke database was created', { smokeDbExists: true }]
    ];

    it.each(DEVIATIONS)('fails when %s', (_name, deviation) => {
        expect(failed(evaluateRefusalCase({ ...refusal, ...deviation })).length).toBeGreaterThan(0);
    });
});

describe('D-35 item 2 / SC5: a timer seeded by one launch is imported by the next, without inflation', () => {
    const raw = JSON.stringify({
        elapsed: 3723, running: true, pomodoroMode: false, pomodoroState: 'work',
        pomodoroSessionCount: 0, lastUpdated: 1_757_000_000_000
    });
    const timer = {
        report: reportOf({ SMOKE_TIMER_IMPORT: 'timerState=imported goalDate=absent' }),
        seeded: { raw, elapsedSeconds: 3723 },
        stored: { raw, elapsedSeconds: 3723, wasRunning: true, lastUpdated: 1_757_000_000_000 },
        workSessions: 0
    };

    it('passes when the raw string and the elapsed seconds both come back unchanged', () => {
        expect(failed(evaluateTimerCase(timer))).toEqual([]);
    });

    it('fails when elapsedSeconds grew while the app was closed (the B12 signature)', () => {
        const inflated = { ...timer.stored, elapsedSeconds: 3723 + 86_400 };
        expect(failed(evaluateTimerCase({ ...timer, stored: inflated })).length).toBeGreaterThan(0);
    });

    it('fails when the raw string was rewritten rather than kept verbatim', () => {
        const rewritten = { ...timer.stored, raw: '{"elapsed":3723}' };
        expect(failed(evaluateTimerCase({ ...timer, stored: rewritten })).length).toBeGreaterThan(0);
    });

    it('fails when app_state holds no legacy timer at all', () => {
        expect(failed(evaluateTimerCase({ ...timer, stored: null })).length).toBeGreaterThan(0);
    });

    it('fails when the import invented a work session', () => {
        expect(failed(evaluateTimerCase({ ...timer, workSessions: 1 })).length).toBeGreaterThan(0);
    });
});

describe('D-32: every normal smoke exit leaves no write-ahead log behind', () => {
    it('passes when the -wal is absent', () => {
        expect(evaluateWalFlushed({ caseName: 'fresh', exists: false, size: 0 }).pass).toBe(true);
    });

    it('passes when the -wal survives at 0 bytes', () => {
        expect(evaluateWalFlushed({ caseName: 'legacy', exists: true, size: 0 }).pass).toBe(true);
    });

    it('fails when the -wal still carries frames', () => {
        expect(evaluateWalFlushed({ caseName: 'timer', exists: true, size: 32_768 }).pass).toBe(false);
    });
});

describe('T-04-50: the harness and the app cannot drift apart on exit codes', () => {
    it('EXPECTED_EXIT_CODES restates EXIT_CODES from src/main/config.ts exactly', () => {
        expect(EXPECTED_EXIT_CODES).toEqual({ ...EXIT_CODES });
    });
});

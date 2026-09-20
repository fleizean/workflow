// The packaged smoke's verdicts are pure functions of what was observed, so every case is judged here in
// milliseconds rather than only inside a 90-second Electron launch. The launches themselves supply the inputs.

import { describe, expect, it } from 'vitest';
import { EXIT_CODES, SMOKE_WATCHDOG_MS } from '../src/main/config';
import {
    BACKUP_DIR as HARNESS_BACKUP_DIR, DATABASE_FILE as HARNESS_DATABASE_FILE, DEFAULT_TIMEOUT_MS, EXPECTED_LATEST,
    REFUSED_NEWER_EXIT_CODE, evaluateFreshCase, evaluateLaunch, evaluateLegacyCase, evaluateRefusalCase,
    evaluateWalFlushed, parseSmokeReport, unpackedBinaryPath
} from '../tools/smoke-packaged.mjs';
import { LATEST } from '../src/lib/db/migrations/registry';
import { BACKUP_DIR, DATABASE_FILE } from '../src/main/database-startup';
import type { DatabaseObservation, SmokeCheck, SmokeReport } from '../tools/smoke-packaged.mjs';

const reportOf = (fields: Record<string, string>): SmokeReport => ({ ok: false, fields });

const exitWith = (code: number): { code: number | null; signal: string | null; timedOut: boolean } =>
    ({ code, signal: null, timedOut: false });

const failed = (checks: readonly SmokeCheck[]): string[] =>
    checks.filter((check) => !check.pass).map((check) => check.label);

/** A window that came up, drew both screens, and played a decoded sound from inside the bundle. */
const HEALTHY_WINDOW = {
    SMOKE_WINDOW_CREATED: 'true',
    SMOKE_HOME_RENDERED: 'true',
    SMOKE_SETTINGS_RENDERED: 'true',
    SMOKE_CONTAINER_TARGET: '28800',
    SMOKE_SOUND_PLAYS: '1',
    SMOKE_SOUND_SRC: 'file:///app.asar/out/renderer/assets/classic-abc.ogg',
    SMOKE_SOUND_ERROR: '0',
    SMOKE_SOUND_DURATION: '0.32'
};

describe('a newer database is refused in the packaged app without a window or a write', () => {
    const hash = 'f'.repeat(64);
    const refusal = {
        exit: exitWith(EXIT_CODES.refusedNewer),
        report: reportOf({ SMOKE_REPORT_KIND: 'refused' }),
        hashBefore: hash,
        hashAfter: hash,
        smokeDbExists: false
    };

    it('passes the refusal that leaves everything as it found it', () => {
        expect(failed(evaluateRefusalCase(refusal))).toEqual([]);
    });

    it('fails a window, a changed file, a smoke database, or the wrong exit code', () => {
        expect(failed(evaluateRefusalCase({ ...refusal, report: reportOf({ SMOKE_REPORT_KIND: 'refused', SMOKE_WINDOW_CREATED: 'true' }) })))
            .toEqual(['no window was ever created']);
        expect(failed(evaluateRefusalCase({ ...refusal, hashAfter: '0'.repeat(64) })))
            .toEqual(['the database file is unchanged, byte for byte']);
        expect(failed(evaluateRefusalCase({ ...refusal, smokeDbExists: true }))).toEqual(['no smoke database was created']);
        expect(failed(evaluateRefusalCase({ ...refusal, exit: exitWith(0) })))
            .toEqual(['the packaged app exited with the refused-newer code']);
    });
});

describe('a healthy launch', () => {
    const fixtureDir = '/tmp/wft-smoke-x/ud';
    const launch = {
        exit: exitWith(0),
        report: { ok: true, fields: { SMOKE_APP_NAME: 'workflow-timer', SMOKE_USER_DATA: fixtureDir } } as SmokeReport,
        fixtureDir
    };

    it('passes when it exited 0, said SMOKE_OK and stayed in the temporary directory', () => {
        expect(failed(evaluateLaunch(launch))).toEqual([]);
    });

    it('fails when userData is anywhere else', () => {
        const elsewhere = { ...launch, report: { ok: true, fields: { ...launch.report.fields, SMOKE_USER_DATA: '/home/someone/.config/workflow-timer' } } };
        expect(failed(evaluateLaunch(elsewhere))).toEqual(['userData was the temporary directory, not a real profile']);
    });

    it('fails a nonzero exit', () => {
        expect(failed(evaluateLaunch({ ...launch, exit: exitWith(1) }))).toContain('the packaged app exited 0');
    });
});

describe('a fresh install', () => {
    const fresh = reportOf({ SMOKE_DB_CLASS: 'fresh', SMOKE_DB_VERSION: String(EXPECTED_LATEST), ...HEALTHY_WINDOW });

    it('passes when the database is new, current, and the window works', () => {
        expect(failed(evaluateFreshCase({ report: fresh }))).toEqual([]);
    });

    it.each([
        ['Home did not render', { SMOKE_HOME_RENDERED: 'false' }, 'Home rendered "Daily Target"'],
        ['Settings did not render', { SMOKE_SETTINGS_RENDERED: 'false' }, 'Settings rendered "Settings"'],
        ['no sound played', { SMOKE_SOUND_PLAYS: '0' }, 'the sound was played from a file inside the app'],
        ['the sound would not decode', { SMOKE_SOUND_ERROR: '4' }, 'the sound decoded, so the bytes are really there'],
        ['the sound came from off the machine', { SMOKE_SOUND_SRC: 'https://example.com/a.ogg' }, 'the sound was played from a file inside the app']
    ])('fails when %s', (_what, change, label) => {
        expect(failed(evaluateFreshCase({ report: reportOf({ ...fresh.fields, ...change }) }))).toEqual([label]);
    });
});

describe('an upgrade from v1.2.1', () => {
    const before: DatabaseObservation = {
        userVersion: 0, companies: 2, workSessions: 3, pomodoroSessions: 1, totalDuration: 6345, nullCompanySessions: 1
    };
    const after: DatabaseObservation = {
        userVersion: EXPECTED_LATEST, companies: 3, workSessions: 3, pomodoroSessions: 1, totalDuration: 6345, nullCompanySessions: 0
    };
    const legacy = {
        report: reportOf({ SMOKE_DB_CLASS: 'legacy', ...HEALTHY_WINDOW }),
        before,
        after,
        backups: ['krono.db.2026-01-05T12-00-00-000Z.bak']
    };

    it('passes when nothing was lost and one backup was taken', () => {
        expect(failed(evaluateLegacyCase(legacy))).toEqual([]);
    });

    it('fails a lost session, a changed total, and a missing or misnamed backup', () => {
        expect(failed(evaluateLegacyCase({ ...legacy, after: { ...after, workSessions: 2 } })))
            .toEqual(['every work session survived']);
        expect(failed(evaluateLegacyCase({ ...legacy, after: { ...after, totalDuration: 6000 } })))
            .toEqual(['sum(duration) is unchanged']);
        expect(failed(evaluateLegacyCase({ ...legacy, backups: [] })))
            .toEqual(['exactly one verified-name backup was taken']);
        expect(failed(evaluateLegacyCase({ ...legacy, backups: ['krono.db.bak'] })))
            .toEqual(['exactly one verified-name backup was taken']);
    });

    it('fails a session left without a company', () => {
        expect(failed(evaluateLegacyCase({ ...legacy, after: { ...after, nullCompanySessions: 1 } })))
            .toEqual(['no work session is left without a company']);
    });
});

describe('a clean exit folds the write-ahead log back in', () => {
    it('passes an absent or empty -wal and fails one still holding bytes', () => {
        expect(evaluateWalFlushed({ caseName: 'fresh', exists: false, size: 0 }).pass).toBe(true);
        expect(evaluateWalFlushed({ caseName: 'fresh', exists: true, size: 0 }).pass).toBe(true);
        expect(evaluateWalFlushed({ caseName: 'fresh', exists: true, size: 4096 }).pass).toBe(false);
    });
});

describe('the harness reads the report the app writes', () => {
    it('turns KEY=value lines into fields and SMOKE_OK into a flag', () => {
        const report = parseSmokeReport('noise\nSMOKE_DB_CLASS=fresh\nSMOKE_OK\nSMOKE_FAIL=x=y\n');
        expect(report.ok).toBe(true);
        expect(report.fields).toEqual({ SMOKE_DB_CLASS: 'fresh', SMOKE_FAIL: 'x=y' });
    });

    it('knows where each platform puts the unpacked executable', () => {
        expect(unpackedBinaryPath('dist', 'linux', 'x64')).toMatch(/linux-unpacked[\\/]workflow-timer$/);
        expect(unpackedBinaryPath('dist', 'win32', 'x64')).toMatch(/win-unpacked[\\/]Workflow\.exe$/);
        expect(unpackedBinaryPath('dist', 'darwin', 'arm64')).toMatch(/mac-arm64[\\/]Workflow\.app/);
    });
});

describe('the harness and the app agree on the constants they both spell', () => {
    it('the database file, backup directory and latest schema version', () => {
        expect(HARNESS_DATABASE_FILE).toBe(DATABASE_FILE);
        expect(HARNESS_BACKUP_DIR).toBe(BACKUP_DIR);
        expect(EXPECTED_LATEST, 'the migration registry moved on and the smoke did not').toBe(LATEST);
    });

    it('the refused-newer exit code', () => {
        expect(REFUSED_NEWER_EXIT_CODE).toBe(EXIT_CODES.refusedNewer);
    });

    it('the app gives up before the harness does, so a stuck run names its own reason', () => {
        expect(SMOKE_WATCHDOG_MS).toBeLessThan(DEFAULT_TIMEOUT_MS);
    });
});

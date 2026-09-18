// D-37: the packaged smoke's verdicts are pure functions of what was observed, so every case is judged here in
// milliseconds rather than only inside a 90-second Electron launch. The launches themselves supply the inputs.

import { describe, expect, it } from 'vitest';
import {
    EXIT_CODES, SMOKE_BUNDLED_FONTS, SMOKE_ICON_MAX_WIDTH_PX, SMOKE_ICON_TEXT_MIN_WIDTH_PX, SMOKE_WATCHDOG_MS
} from '../src/main/config';
import { IPC_CHANNELS } from '../src/shared/ipc/channels';
import {
    BACKUP_DIR as HARNESS_BACKUP_DIR, DATABASE_FILE as HARNESS_DATABASE_FILE,
    DEFAULT_TIMEOUT_MS, EXPECTED_BUNDLED_FONTS, EXPECTED_EXIT_CODES, EXPECTED_ICON_MAX_WIDTH_PX,
    EXPECTED_ICON_TEXT_MIN_WIDTH_PX, EXPECTED_IPC_CHANNELS, EXPECTED_LATEST, EXPECTED_SERVICES,
    EXPECTED_TRAY_RESET_LABEL, EXPECTED_WATCHDOG_MS, evaluateRefusalCase, evaluateTimerCase, evaluateWalFlushed,
    evaluateWindowRecovery
} from '../tools/smoke-packaged.mjs';
import { LATEST } from '../src/lib/db/migrations/registry';
import { BACKUP_DIR, DATABASE_FILE } from '../src/main/database-startup';
import { RESET_POSITION_LABEL } from '../src/main/tray';
import { read } from './helpers/ts-imports';
import type { SmokeCheck, SmokeReport } from '../tools/smoke-packaged.mjs';

const NEWER_HASH = 'f'.repeat(64);

const reportOf = (fields: Record<string, string>): SmokeReport => ({ ok: false, fields });

const exitWith = (code: number): { code: number | null; signal: string | null; timedOut: boolean } =>
    ({ code, signal: null, timedOut: false });

const failed = (checks: readonly SmokeCheck[]): string[] =>
    checks.filter((check) => !check.pass).map((check) => check.label);

const refusal = {
    exit: exitWith(EXIT_CODES.refusedNewer),
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
        ['the app exited 0 instead of the refusal code', { exit: exitWith(0) }],
        ['the app exited with the wrong refusal code', { exit: exitWith(EXIT_CODES.refusedUnrecognized) }],
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

    it('EXPECTED_IPC_CHANNELS restates the contract channel count, so a new channel is smoked too', () => {
        expect(EXPECTED_IPC_CHANNELS).toBe(IPC_CHANNELS.length);
    });

    /*
     * A smoke launch shows no window and creates no tray, so a run that hangs is a process only Task Manager can
     * end. The app gives itself a deadline; the harness's kill is the backstop behind it, and the order matters -
     * the other way round, every hang is reported as an anonymous kill with nothing said about how far it got.
     */
    it('lets the app time itself out before the harness kills it', () => {
        expect(EXPECTED_WATCHDOG_MS, 'the harness and the app disagree on the deadline').toBe(SMOKE_WATCHDOG_MS);
        expect(SMOKE_WATCHDOG_MS, 'the harness would kill the launch before it could say why it stopped')
            .toBeLessThan(DEFAULT_TIMEOUT_MS);
    });

    it('arms that deadline on every smoke launch and fails on it, rather than passing', () => {
        const source = read('src/main/smoke.ts');
        expect(source, 'nothing arms the watchdog').toContain('armWatchdog(lines)');
        expect(source, 'a watchdog that exits ok would report a hang as a pass').toContain('EXIT_CODES.smokeStuck');
        expect(source, 'the watchdog reports a pass').toMatch(/ok: false,\s+code: EXIT_CODES\.smokeStuck/);
        expect(source, 'a finished run would still be killed by its own watchdog').toContain('clearTimeout(watchdog)');
    });

    // The same seven names tests/container.test.ts reads off the real container, so neither can move alone.
    it('EXPECTED_SERVICES restates what the container composes', () => {
        expect(EXPECTED_SERVICES).toBe('companies,goal,pomodoro,sessions,settings,stats,timer');
    });

    // SPA-08/SPA-09: the app measures, the harness judges. A bound loosened on one side alone would pass both.
    it('the icon-width bounds and the font list restate src/main/config.ts', () => {
        expect(EXPECTED_ICON_MAX_WIDTH_PX).toBe(SMOKE_ICON_MAX_WIDTH_PX);
        expect(EXPECTED_ICON_TEXT_MIN_WIDTH_PX).toBe(SMOKE_ICON_TEXT_MIN_WIDTH_PX);
        expect([...EXPECTED_BUNDLED_FONTS]).toEqual([...SMOKE_BUNDLED_FONTS]);
    });

    /*
     * V2-SCHEMA-02: the harness seeds and reads a file by name. Flipping DATABASE_RENAME_RELEASED changes the name
     * the app uses, and a harness still naming krono.db would seed a file the app never opens and then report a
     * green smoke against a fresh empty database. Held here so the two names cannot move apart.
     */
    it('the database filename, the backup directory and LATEST restate their sources', () => {
        expect(HARNESS_DATABASE_FILE).toBe(DATABASE_FILE);
        expect(HARNESS_BACKUP_DIR).toBe(BACKUP_DIR);
        expect(EXPECTED_LATEST).toBe(LATEST);
    });

    /*
     * Phase 10 criterion 5: the harness finds the tray item by its label. Renaming the item without renaming this
     * would leave the check looking for a menu entry that no longer exists - and it reports on the WHOLE menu
     * string, so an absent item reads as a pass to nobody but a careless eye.
     */
    it('the tray reset label restates src/main/tray.ts', () => {
        expect(EXPECTED_TRAY_RESET_LABEL).toBe(RESET_POSITION_LABEL);
    });
});

/*
 * Phase 10 criterion 5 again, as pure judgement. The launch supplies the numbers; what they MEAN is decided here,
 * where the two controls can be shown to fail: a saved rectangle that was never off-screen, and a window that was
 * already on a display before the reset was clicked, would both make the claim vacuous.
 */
describe('criterion 5: an off-screen window comes back', () => {
    const recovered: Record<string, string> = {
        SMOKE_DISPLAYS: '2',
        SMOKE_OFFSCREEN_SAVED: '-30000,-30000 500x700',
        SMOKE_OFFSCREEN_SAVED_ON_DISPLAY: 'false',
        SMOKE_OFFSCREEN_OPENED: '745,50 430x932',
        SMOKE_OFFSCREEN_ON_DISPLAY: 'true',
        SMOKE_TRAY_MENU: 'Show Workflow|Reset window position|separator|Quit Workflow',
        SMOKE_TRAY_RESET_BEFORE: '-30000,-30000 500x700',
        SMOKE_TRAY_RESET_BEFORE_ON_DISPLAY: 'false',
        SMOKE_TRAY_RESET_AFTER: '745,50 430x932',
        SMOKE_TRAY_RESET_AFTER_ON_DISPLAY: 'true',
        SMOKE_TRAY_RESET_CALLS: '1',
        SMOKE_TRAY_RESET_PERSISTED: 'true'
    };
    const failuresFor = (fields: Record<string, string>): string[] =>
        evaluateWindowRecovery({ report: { ok: true, fields } })
            .filter((check: SmokeCheck) => !check.pass).map((check: SmokeCheck) => check.label);

    it('passes the launch that recovered', () => {
        expect(failuresFor(recovered)).toEqual([]);
    });

    it('fails a saved rectangle that was never off-screen, so the fallback proved nothing', () => {
        expect(failuresFor({ ...recovered, SMOKE_OFFSCREEN_SAVED_ON_DISPLAY: 'true' }))
            .toEqual(['the saved off-screen rectangle really is one this machine would refuse']);
    });

    it('fails a window that did not come back, and one the menu offers no way back for', () => {
        expect(failuresFor({ ...recovered, SMOKE_OFFSCREEN_ON_DISPLAY: 'false' }))
            .toEqual(['a window whose saved bounds are entirely off-screen opens on a display that exists']);
        expect(failuresFor({ ...recovered, SMOKE_TRAY_MENU: 'Show Workflow|separator|Quit Workflow' }))
            .toEqual(['the tray menu offers a way back for a window nobody can reach']);
    });

    it('fails a reset clicked on a window that was already on screen', () => {
        expect(failuresFor({ ...recovered, SMOKE_TRAY_RESET_BEFORE_ON_DISPLAY: 'true' }))
            .toEqual(['the window really was off-screen before the reset item was clicked']);
    });

    it('fails a reset that moved nothing, fired twice, or was not written back', () => {
        expect(failuresFor({ ...recovered, SMOKE_TRAY_RESET_AFTER_ON_DISPLAY: 'false' }))
            .toEqual(['clicking it put the window back on a display, and told the action exactly once']);
        expect(failuresFor({ ...recovered, SMOKE_TRAY_RESET_CALLS: '2' }))
            .toEqual(['clicking it put the window back on a display, and told the action exactly once']);
        expect(failuresFor({ ...recovered, SMOKE_TRAY_RESET_PERSISTED: 'false' }))
            .toEqual(['the reset was written back, so the next launch opens where it was moved to']);
    });

    it('fails a launch that saw no display at all, where every answer above would be meaningless', () => {
        expect(failuresFor({ ...recovered, SMOKE_DISPLAYS: '0' }))
            .toContain('the harness saw at least one display, so the recovery claim is about something');
    });
});

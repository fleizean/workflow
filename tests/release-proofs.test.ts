/*
 * The judgement behind two proofs that need two OS processes and a packaged build to produce their inputs:
 * criterion 6 (installing over v1.2.1 loses nothing) and IPC-07 (a second launch is sent back to the first).
 *
 * `npm run upgrade:check` and `npm run instance:check` are the gates. What runs in the ordinary suite is what
 * decides whether the numbers those launches produced mean the claim holds - exercised with the failures each is
 * supposed to catch, because a verdict function that has never been shown to fail carries nothing.
 */

import { describe, expect, it } from 'vitest';
import { judgeUpgrade, STREAK_DAYS } from '../tools/upgrade-over-v121.mjs';
import { judgeSecondInstance } from '../tools/second-instance.mjs';
import type { UpgradeCheck } from '../tools/upgrade-over-v121.mjs';

const seededSessions = [
    { name: 'Fixture task: one', duration: 9900, date: '2026-09-18', company_id: 2, note: 'a note' },
    { name: 'Fixture task: two', duration: 9900, date: '2026-09-18', company_id: 3, note: null }
];

const seeded = {
    sessions: seededSessions,
    companies: [
        { id: 1, name: 'Unassigned', note_required: 0 },
        { id: 3, name: 'Contoso Fixture', note_required: 1 }
    ],
    settings: {
        daily_target: '28800',
        goal_notification: 'true',
        exclude_weekends_from_streak: 'false',
        pomodoro_enabled: 'false',
        pomodoro_work_duration: '1500',
        pomodoro_short_break: '300',
        pomodoro_long_break: '900',
        pomodoro_sessions_until_long_break: '4'
    },
    streak: STREAK_DAYS,
    today: '2026-09-18'
};

const read = {
    errors: [] as string[],
    sessions: [
        // Renumbered ids on purpose: a migration may renumber, and that is not a loss.
        { id: 91, name: 'Fixture task: one', durationSeconds: 9900, date: '2026-09-18', companyId: 2, note: 'a note' },
        { id: 92, name: 'Fixture task: two', durationSeconds: 9900, date: '2026-09-18', companyId: 3, note: null }
    ],
    companies: [
        { id: 1, name: 'Unassigned', noteRequired: false },
        { id: 3, name: 'Contoso Fixture', noteRequired: true }
    ],
    settings: {
        dailyTargetSeconds: 28800,
        goalNotification: true,
        excludeWeekendsFromStreak: false,
        pomodoroEnabled: false,
        pomodoroWorkSeconds: 1500,
        pomodoroShortBreakSeconds: 300,
        pomodoroLongBreakSeconds: 900,
        pomodoroSessionsUntilLongBreak: 4
    },
    streak: STREAK_DAYS
};

const backups = ['krono.db.2026-09-18T08-19-43-732Z.bak'];

const upgradeFailures = (over: Record<string, unknown>): string[] =>
    judgeUpgrade({ seeded, read: { ...read, ...over }, backups })
        .filter((check: UpgradeCheck) => !check.pass).map((check: UpgradeCheck) => check.label);

describe('criterion 6: what the app gives back after installing over v1.2.1', () => {
    it('passes a migration that kept everything, even with the ids renumbered', () => {
        expect(upgradeFailures({})).toEqual([]);
    });

    it('fails a session that was dropped, and one whose note was rewritten', () => {
        expect(upgradeFailures({ sessions: read.sessions.slice(1) })).toEqual([
            'every work session came back, field for field',
            'no second of tracked time was lost or invented'
        ]);
        // The note is the user's text, and NULL versus empty is the distinction the app hangs the attribution
        // prompt on - so a note that changed is a session that did not come back.
        const renoted = read.sessions.map((row, index) => (index === 0 ? { ...row, note: 'something else' } : row));
        expect(upgradeFailures({ sessions: renoted })).toEqual(['every work session came back, field for field']);
    });

    it('fails a duration that changed while the count stayed right - the rounding-to-six-minutes shape', () => {
        const rounded = read.sessions.map((row) => ({ ...row, durationSeconds: 9600 }));
        expect(upgradeFailures({ sessions: rounded })).toEqual([
            'every work session came back, field for field',
            'no second of tracked time was lost or invented'
        ]);
    });

    it('fails a company that vanished, and a note_required flag that was lost with the retired columns', () => {
        expect(upgradeFailures({ companies: read.companies.slice(0, 1) })).toEqual([
            'every company came back, by name',
            'note_required survived the sheets retirement, which dropped the columns beside it'
        ]);
        const unflagged = read.companies.map((row) => ({ ...row, noteRequired: false }));
        expect(upgradeFailures({ companies: unflagged }))
            .toEqual(['note_required survived the sheets retirement, which dropped the columns beside it']);
    });

    it('fails a streak the app got wrong in either direction', () => {
        expect(upgradeFailures({ streak: STREAK_DAYS - 1 }))
            .toEqual(['the streak is the ' + String(STREAK_DAYS) + ' consecutive days the fixture holds']);
        expect(upgradeFailures({ streak: STREAK_DAYS + 1 }))
            .toContain('the streak is the ' + String(STREAK_DAYS) + ' consecutive days the fixture holds');
    });

    it('fails settings that came back as defaults instead of as what the user set', () => {
        expect(upgradeFailures({ settings: { ...read.settings, dailyTargetSeconds: 28801 } }))
            .toEqual(['the daily target survived']);
        expect(upgradeFailures({ settings: { ...read.settings, pomodoroWorkSeconds: 1499 } }))
            .toEqual(['the four pomodoro durations survived']);
        expect(upgradeFailures({ settings: { ...read.settings, goalNotification: false } }))
            .toEqual(['the boolean preferences survived, with their values and not their defaults']);
    });

    it('fails a failed IPC call rather than treating an empty answer as an empty database', () => {
        const failures = upgradeFailures({ errors: ['settings:get -> {"code":"INTERNAL"}'], settings: {} });
        expect(failures[0]).toBe('the app answered every question it was asked');
    });

    it('fails a migration that took no backup, or more than one', () => {
        const noBackup = judgeUpgrade({ seeded, read, backups: [] })
            .filter((check: UpgradeCheck) => !check.pass).map((check: UpgradeCheck) => check.label);
        expect(noBackup).toEqual(['the migration took exactly one backup before touching anything']);
    });
});

const surfaced = {
    first: {
        alive: true, windowsBefore: 1, visibleBefore: false, windowsAfter: 1, visibleAfter: true, companiesAfter: 4
    },
    second: { exited: true, timedOut: false, code: 0, signal: null, ms: 136, stdout: '', stderr: '' },
    walFiles: ['krono.db-wal']
};

const instanceFailures = (over: Record<string, unknown>): string[] =>
    judgeSecondInstance({ ...surfaced, ...over })
        .filter((check: UpgradeCheck) => !check.pass).map((check: UpgradeCheck) => check.label);

describe('IPC-07: a second launch is sent back to the first', () => {
    it('passes the launch that behaved', () => {
        expect(instanceFailures({})).toEqual([]);
    });

    it('fails a second process that stayed up - two processes on one SQLite file', () => {
        expect(instanceFailures({ second: { ...surfaced.second, exited: false, timedOut: true, code: null } }))
            .toEqual(['the second launch exited by itself', 'the second launch exited cleanly, not by crashing']);
    });

    it('fails a second process that exited by crashing rather than by quitting at the lock', () => {
        expect(instanceFailures({ second: { ...surfaced.second, code: 1, stderr: 'TypeError: boom' } }))
            .toEqual(['the second launch exited cleanly, not by crashing', 'the second launch said nothing on stderr']);
    });

    it('fails a second window opened on the same database', () => {
        expect(instanceFailures({ first: { ...surfaced.first, windowsAfter: 2 } }))
            .toEqual(['there is still exactly one main window, not a second one on the same database']);
    });

    it('fails a first window that was never surfaced, which is the whole point of the handler', () => {
        expect(instanceFailures({ first: { ...surfaced.first, visibleAfter: false } }))
            .toEqual(['the existing window was surfaced rather than ignored']);
    });

    it('fails a window that was already visible, where surfacing could not be observed', () => {
        expect(instanceFailures({ first: { ...surfaced.first, visibleBefore: true } }))
            .toEqual(['the first launch opened exactly one window, and it was hidden before the second']);
    });

    it('fails a first process that died, or stopped answering from its database', () => {
        expect(instanceFailures({ first: { ...surfaced.first, alive: false } }))
            .toEqual(['the first process is still alive']);
        expect(instanceFailures({ first: { ...surfaced.first, companiesAfter: -1 } }))
            .toEqual(['the first process still answers from its own database, so nothing took the file from it']);
    });

    it('fails a second write-ahead log, which is what a second writer leaves behind', () => {
        expect(instanceFailures({ walFiles: ['krono.db-wal', 'krono.db-wal2'] }))
            .toEqual(['the second launch left no second write-ahead log beside the database']);
    });
});

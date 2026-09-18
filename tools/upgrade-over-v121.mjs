#!/usr/bin/env node
/*
 * Phase 10 criterion 6, the half that does not need CI: installing over v1.2.1 loses nothing.
 *
 *   npm run upgrade:check          build:unpack first - this drives the packaged build
 *
 * WHAT THE PACKAGED SMOKE ALREADY PROVES, and why this is not that. smoke-packaged.mjs's `legacy` case seeds a
 * v1.2.1-shaped krono.db, launches the packaged app and reads the file back with better-sqlite3. That is a claim
 * about the FILE.
 *
 * The criterion is about the USER: "preserves every session, company, streak value, and setting". So this asks the
 * running application, through the same bridge the screens use - renderer -> preload -> IPC -> service ->
 * repository -> Drizzle -> SQLite - and compares what comes back, row by row, against what was seeded. A migration
 * that preserved every byte and a repository that mapped a column wrong would pass the smoke and fail here.
 *
 * The streak is the value the criterion names and the one nothing else checks end to end: the fixture is built so
 * a known number of consecutive days clear the daily target, with a deliberate gap before them, and the answer the
 * app gives has to be that number and not the larger one it would be without the gap.
 *
 * SAFETY. Everything happens in a mkdtemp directory; the fixture is synthetic and every name in it is invented.
 */

/* global window */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright-core';

import { appWindow } from './baseline/capture-v2.mjs';
import { childEnvironment } from './baseline/probe-userdata.mjs';
import { V121_DDL, addDays, formatLocalDate } from './baseline/seed-baseline-db.mjs';
import { BACKUP_DIR, DATABASE_FILE, unpackedBinaryPath } from './smoke-packaged.mjs';

const SCRIPT_NAME = 'tools/upgrade-over-v121.mjs';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The daily target the fixture sets, in seconds, and the streak it is built to produce. */
export const DAILY_TARGET_SECONDS = 28_800;
export const STREAK_DAYS = 12;
/** Days before the streak that fall short, so the answer is bounded above as well as below. */
const SHORT_DAYS = 3;
const SHORT_SECONDS = 7_200;

/* Every string is invented. "Northwind", "Contoso" and "Fabrikam" are Microsoft's own fictional companies. */
const COMPANIES = [
    { id: 1, name: 'Unassigned', note_required: 0 },
    { id: 2, name: 'Northwind Fixture', note_required: 0 },
    { id: 3, name: 'Contoso Fixture', note_required: 1 },
    { id: 4, name: 'Fabrikam Fixture', note_required: 0 }
];

/* v1.2.1's own settings keys, including two the retirement migration must delete. */
const SETTINGS = {
    daily_target: String(DAILY_TARGET_SECONDS),
    goal_notification: 'true',
    start_reminder: 'false',
    haptic_feedback: 'true',
    exclude_weekends_from_streak: 'false',
    pomodoro_enabled: 'false',
    pomodoro_work_duration: '1500',
    pomodoro_short_break: '300',
    pomodoro_long_break: '900',
    pomodoro_sessions_until_long_break: '4',
    pomodoro_auto_start_breaks: 'true',
    pomodoro_auto_start_work: 'false',
    export_half_hour_precision: 'false',
    script_url: 'https://example.invalid/never-called'
};

/* ---------------------------------------------------------------------------------------- */
/* The fixture, and what it should look like afterwards                                       */
/* ---------------------------------------------------------------------------------------- */

/*
 * A populated v1.2.1 database: a broken streak, then STREAK_DAYS consecutive days over the target built out of
 * SEVERAL sessions each - which is B7, the bug v1.2.1 had where a day worked in short blocks never counted.
 */
export function seedPopulatedV121(dbPath) {
    // Local midnight, which is the day boundary v1.2.1 wrote into its date columns.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const sessions = [];
    for (let back = 0; back < STREAK_DAYS; back++) {
        const date = formatLocalDate(addDays(midnight, -back));
        // Three blocks that only together clear the target: 3 x 9900 = 29,700 s.
        for (let block = 0; block < 3; block++) {
            sessions.push({
                name: 'Fixture task: block ' + String(block + 1) + ' of day ' + String(back),
                duration: 9_900,
                date,
                company_id: 2 + ((back + block) % 3),
                note: block === 0 ? 'Synthetic fixture note. No real work was recorded here.' : null
            });
        }
    }
    for (let back = STREAK_DAYS; back < STREAK_DAYS + SHORT_DAYS; back++) {
        sessions.push({
            name: 'Fixture task: a short day',
            duration: SHORT_SECONDS,
            date: formatLocalDate(addDays(midnight, -back)),
            company_id: 2,
            note: null
        });
    }

    const db = new DatabaseSync(dbPath);
    try {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec(V121_DDL);
        const insertCompany = db.prepare(
            'INSERT INTO companies (id, name, created_at, updated_at, excel_column, note_column, note_required) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const stamp = formatLocalDate(addDays(midnight, -60)) + ' 08:00:00';
        for (const company of COMPANIES) {
            insertCompany.run(company.id, company.name, stamp, stamp, 'B', 'C', company.note_required);
        }
        const insertSession = db.prepare(
            'INSERT INTO work_sessions (name, duration, date, created_at, company_id, note) VALUES (?, ?, ?, ?, ?, ?)'
        );
        for (const [index, session] of sessions.entries()) {
            insertSession.run(
                session.name, session.duration, session.date,
                session.date + ' ' + String(9 + (index % 8)).padStart(2, '0') + ':00:00',
                session.company_id, session.note
            );
        }
        const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
        for (const [key, value] of Object.entries(SETTINGS)) insertSetting.run(key, value);
        db.prepare(
            'INSERT INTO pomodoro_sessions (date, company_id, pomodoros_completed, created_at) VALUES (?, ?, ?, ?)'
        ).run(formatLocalDate(midnight), 2, 4, formatLocalDate(midnight) + ' 11:00:00');
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
        db.close();
    }

    return {
        sessions,
        companies: COMPANIES,
        settings: SETTINGS,
        streak: STREAK_DAYS,
        today: formatLocalDate(midnight)
    };
}

/* ---------------------------------------------------------------------------------------- */
/* Verdicts                                                                                   */
/* ---------------------------------------------------------------------------------------- */

const totalSeconds = (rows) => rows.reduce((sum, row) => sum + row.durationSeconds, 0);

/** A session reduced to what the user typed, so an id renumbered by a migration is not a difference. */
const sessionKey = (row) => JSON.stringify([row.name, row.durationSeconds, row.date, row.note]);

export function judgeUpgrade({ seeded, read, backups }) {
    const checks = [];
    const check = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail: String(detail) });

    check('the app answered every question it was asked',
        read.errors.length === 0, read.errors.join('; ') || 'no failed call');

    /* Sessions, as multisets of what the user typed - not as ids, which a migration is entitled to renumber. */
    const before = seeded.sessions
        .map((s) => JSON.stringify([s.name, s.duration, s.date, s.note])).sort();
    const after = read.sessions.map(sessionKey).sort();
    check('every work session came back, field for field',
        before.length === after.length && before.every((key, index) => key === after[index]),
        String(before.length) + ' seeded, ' + String(after.length) + ' read back' +
            (before.length === after.length ? '' : ''));
    check('no second of tracked time was lost or invented',
        totalSeconds(read.sessions) === seeded.sessions.reduce((sum, s) => sum + s.duration, 0),
        String(totalSeconds(read.sessions)) + 's read back, ' +
            String(seeded.sessions.reduce((sum, s) => sum + s.duration, 0)) + 's seeded');

    /* Companies: every seeded name survives, and the one v1.2.1 always had is still the one sessions point at. */
    const seededNames = seeded.companies.map((c) => c.name).sort();
    const readNames = read.companies.map((c) => c.name).sort();
    check('every company came back, by name',
        seededNames.every((name) => readNames.includes(name)),
        readNames.join(', '));
    check('note_required survived the sheets retirement, which dropped the columns beside it',
        read.companies.filter((c) => c.noteRequired === true).map((c) => c.name).join(',') === 'Contoso Fixture',
        read.companies.map((c) => c.name + '=' + String(c.noteRequired)).join(' '));

    /* The streak: the value the criterion names, answered by the app rather than recomputed from the file. */
    check('the streak is the ' + String(seeded.streak) + ' consecutive days the fixture holds',
        read.streak === seeded.streak, 'the app says ' + String(read.streak));
    check('the short days before the streak really do fall short, so the answer is bounded above',
        read.streak < seeded.streak + SHORT_DAYS,
        String(seeded.streak) + ' full days then ' + String(SHORT_DAYS) + ' at ' + String(SHORT_SECONDS) + 's');

    /* Settings the user set, read back through the settings service rather than out of the table. */
    check('the daily target survived',
        read.settings.dailyTargetSeconds === Number(seeded.settings.daily_target),
        String(read.settings.dailyTargetSeconds) + ' vs ' + seeded.settings.daily_target);
    check('the four pomodoro durations survived',
        read.settings.pomodoroWorkSeconds === Number(seeded.settings.pomodoro_work_duration) &&
        read.settings.pomodoroShortBreakSeconds === Number(seeded.settings.pomodoro_short_break) &&
        read.settings.pomodoroLongBreakSeconds === Number(seeded.settings.pomodoro_long_break) &&
        read.settings.pomodoroSessionsUntilLongBreak === Number(seeded.settings.pomodoro_sessions_until_long_break),
        [read.settings.pomodoroWorkSeconds, read.settings.pomodoroShortBreakSeconds,
            read.settings.pomodoroLongBreakSeconds, read.settings.pomodoroSessionsUntilLongBreak].join('/'));
    check('the boolean preferences survived, with their values and not their defaults',
        read.settings.goalNotification === (seeded.settings.goal_notification === 'true') &&
        read.settings.excludeWeekendsFromStreak === (seeded.settings.exclude_weekends_from_streak === 'true') &&
        read.settings.pomodoroEnabled === (seeded.settings.pomodoro_enabled === 'true'),
        'goal=' + String(read.settings.goalNotification) + ' weekends=' + String(read.settings.excludeWeekendsFromStreak) +
            ' pomodoro=' + String(read.settings.pomodoroEnabled));

    /* The migration's own safety net, without which none of the above would be recoverable if it went wrong. */
    check('the migration took exactly one backup before touching anything',
        backups.length === 1, backups.join(', ') || 'none');

    return checks;
}

/* ---------------------------------------------------------------------------------------- */
/* Driving                                                                                    */
/* ---------------------------------------------------------------------------------------- */

/*
 * Read through the page's own bridge. Every answer is an IpcResult, so a failed call arrives as data rather than
 * as a thrown harness error - and is reported as one, instead of being retried until something looked right.
 */
function readThroughTheBridgeInPage() {
    const api = window.api;
    const errors = [];
    const unwrap = async (channel, input) => {
        const answer = await api[channel](input);
        if (answer === undefined || answer.ok !== true) {
            errors.push(channel + ' -> ' + JSON.stringify(answer?.error ?? answer));
            return null;
        }
        return answer.data;
    };
    return (async () => {
        const sessions = await unwrap('sessions:list');
        const companies = await unwrap('companies:list');
        const settings = await unwrap('settings:get');
        const streak = await unwrap('stats:streak');
        return {
            errors,
            sessions: sessions ?? [],
            companies: companies ?? [],
            settings: settings ?? {},
            streak: streak?.days ?? -1
        };
    })();
}

export async function runUpgradeCheck(options = {}) {
    const log = options.quiet ? () => {} : (...parts) => { console.log(...parts); };
    const distDir = path.resolve(options.distDir ?? path.join(repoRoot, 'dist'));
    const binary = unpackedBinaryPath(distDir, process.platform, process.arch);
    if (!fs.existsSync(binary)) {
        throw new Error('no unpacked build at ' + binary + ' - run `npm run build:unpack` first');
    }

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-upgrade-'));
    const fixtureDir = path.join(fixtureRoot, 'ud');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const dbPath = path.join(fixtureDir, DATABASE_FILE);
    const seeded = seedPopulatedV121(dbPath);
    log(SCRIPT_NAME + ': seeded a v1.2.1-shaped ' + DATABASE_FILE + ' - ' + seeded.sessions.length +
        ' sessions, ' + seeded.companies.length + ' companies, a ' + seeded.streak + '-day streak');

    const { env } = childEnvironment();
    let app = null;
    let read = { errors: ['the app never answered'], sessions: [], companies: [], settings: {}, streak: -1 };

    try {
        app = await electron.launch({
            executablePath: binary,
            env,
            args: ['--no-sandbox', '--user-data-dir=' + fixtureDir, '--force-device-scale-factor=1'],
            timezoneId: 'Europe/Istanbul',
            locale: 'tr-TR',
            colorScheme: 'dark'
        });
        const page = await appWindow(app);
        await page.waitForLoadState('load');
        await page.waitForFunction(() => window.api !== undefined, undefined, { timeout: 30_000 });
        read = await page.evaluate(readThroughTheBridgeInPage);
    } finally {
        if (app) {
            const pid = app.process().pid;
            try {
                await Promise.race([
                    app.evaluate(({ app: electronApp }) => electronApp.exit(0)),
                    new Promise((resolve) => { setTimeout(resolve, 10_000); })
                ]);
            } catch { /* already gone */ }
            try {
                if (process.platform === 'win32') {
                    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
                } else {
                    process.kill(pid, 'SIGKILL');
                }
            } catch { /* the expected path */ }
        }
    }

    const backupDir = path.join(fixtureDir, BACKUP_DIR);
    const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    const checks = judgeUpgrade({ seeded, read, backups });

    try {
        fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch { /* harmless */ }

    return { checks, seeded, read, backups };
}

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    let result;
    try {
        result = await runUpgradeCheck();
    } catch (error) {
        console.error(SCRIPT_NAME + ': ' + (error.stack ?? error.message));
        console.error(SCRIPT_NAME + ': run `npm run build:unpack` first; this gate drives the packaged app.');
        process.exit(1);
    }

    for (const check of result.checks) {
        console.log((check.pass ? 'PASS  ' : 'FAIL  ') + check.label + ' - ' + check.detail);
    }
    const failed = result.checks.filter((check) => !check.pass);
    console.log(SCRIPT_NAME + ': ' + (result.checks.length - failed.length) + '/' + result.checks.length +
        ' checks passed');
    if (failed.length > 0) {
        console.error(SCRIPT_NAME + ': installing over v1.2.1 would NOT preserve what the user had.');
        process.exit(1);
    }
    console.log('UPGRADE_OVER_V121_OK');
    process.exit(0);
}

#!/usr/bin/env node
// BUILD-05/06 (D-13, D-14) and D-37: launches the packaged build against temp userData directories, one case per
// launch, and checks what it reports and what it left on disk.
// Usage: node tools/smoke-packaged.mjs [--keep] [--dist=PATH] [--case=NAME]

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnvironment, realUserDataDir, SCRUBBED_ENV } from './baseline/probe-userdata.mjs';

const SCRIPT_NAME = 'tools/smoke-packaged.mjs';

/** package.json `name` - what Electron derives userData from. Never productName. */
export const EXPECTED_APP_NAME = 'workflow-timer';
/** electron-builder.yml productName - what the packaged executable is called. */
export const PRODUCT_NAME = 'Workflow';
export const SMOKE_DB_ENV = 'WORKFLOW_SMOKE_DB';
export const SMOKE_DB_NAME = 'smoke.db';
export const DEFAULT_TIMEOUT_MS = 90_000;
/** The heading the renderer's index route renders (src/renderer/src/routes/Home.tsx). Must match src/main/index.ts. */
export const RENDERER_MARKER_TEXT = 'Home';

/** src/main/database-startup.ts's DATABASE_FILE and BACKUP_DIR, and the registry's LATEST. */
export const DATABASE_FILE = 'krono.db';
export const BACKUP_DIR = 'backups';
export const EXPECTED_LATEST = 2;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V121_FIXTURE = path.join(repoRoot, 'tests', 'fixtures', 'v121.sql');
const require = createRequire(import.meta.url);

/* ---------------------------------------------------------------------------------------- */
/* Pure pieces                                                                              */
/* ---------------------------------------------------------------------------------------- */

// Where electron-builder --dir puts the executable; only x64 lands in the unsuffixed directory.
export function unpackedBinaryPath(distDir, platform, arch) {
    if (platform === 'win32') {
        const dir = arch === 'x64' ? 'win-unpacked' : 'win-' + arch + '-unpacked';
        return path.join(distDir, dir, PRODUCT_NAME + '.exe');
    }
    if (platform === 'darwin') {
        const dir = arch === 'x64' ? 'mac' : 'mac-' + arch;
        return path.join(distDir, dir, PRODUCT_NAME + '.app', 'Contents', 'MacOS', PRODUCT_NAME);
    }
    throw new Error(SCRIPT_NAME + ': no packaged smoke launch is defined for ' + platform);
}

// The production userData directory: never touched, and the reported app name must resolve to it.
export function expectedProductionUserDataDir(platform = process.platform, home = os.homedir()) {
    if (platform === 'win32') return realUserDataDir();
    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', EXPECTED_APP_NAME);
    throw new Error(SCRIPT_NAME + ': no production userData location is defined for ' + platform);
}

// canonicalPath from src/main/userdata-path.ts: the nearest existing ancestor goes through realpath (IN-06).
function canonicalPath(p) {
    const tail = [];
    let existing = path.resolve(p);
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) return path.resolve(p);
        tail.unshift(path.basename(existing));
        existing = parent;
    }
    return path.join(fs.realpathSync.native(existing), ...tail);
}

/** isSameOrInside from src/main/userdata-path.ts, restated for plain Node; tests/userdata-path.test.ts holds the two together (WR-04). */
export function isWithin(parent, child) {
    const fold = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? canonicalPath(p).toLowerCase() : canonicalPath(p));
    const rel = path.relative(fold(parent), fold(child));
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// Two spellings of one directory; realpath catches Windows 8.3 names and macOS's /var symlink.
export function sameDirectory(a, b) {
    if (path.resolve(a) === path.resolve(b)) return true;
    try {
        return fs.realpathSync.native(a) === fs.realpathSync.native(b);
    } catch {
        return false;
    }
}

/** SMOKE_* lines from the app's stdout. KEY=value lines become fields; SMOKE_OK is a flag. */
export function parseSmokeReport(stdout) {
    const report = { ok: false, fields: {} };
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === 'SMOKE_OK') {
            report.ok = true;
            continue;
        }
        const eq = line.indexOf('=');
        if (line.startsWith('SMOKE_') && eq > 0) report.fields[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return report;
}

// Every assertion as { label, pass, detail }. Pure: the caller supplies what was observed.
export function evaluateSmoke({ exit, report, childEnv, fixtureDir, fixtureDb, fixtureDbSize, productionDir }) {
    const checks = [];
    const check = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail });
    const f = report.fields;

    const leaked = SCRUBBED_ENV.filter((name) => Object.prototype.hasOwnProperty.call(childEnv, name));
    check('the child environment carries neither ' + SCRUBBED_ENV.join(' nor '), leaked.length === 0,
        leaked.length === 0 ? 'scrubbed' : 'still present: ' + leaked.join(', '));

    check('the packaged app exited 0', exit.code === 0,
        'code=' + String(exit.code) + ' signal=' + String(exit.signal) +
        (exit.timedOut ? ' (killed by the hard timeout)' : ''));

    check('stdout carried SMOKE_OK', report.ok, f.SMOKE_FAIL ?? (report.ok ? 'present' : 'absent'));

    check('the application name is ' + EXPECTED_APP_NAME, f.SMOKE_APP_NAME === EXPECTED_APP_NAME,
        'reported ' + JSON.stringify(f.SMOKE_APP_NAME));

    const resolved = f.SMOKE_APP_DATA !== undefined && f.SMOKE_APP_NAME !== undefined
        ? path.join(f.SMOKE_APP_DATA, f.SMOKE_APP_NAME)
        : null;
    check('join(appData, name) equals the v1.2.1 userData directory, byte for byte',
        resolved === productionDir, JSON.stringify(resolved) + ' vs ' + JSON.stringify(productionDir));

    const userData = f.SMOKE_USER_DATA;
    check('the reported userData is the fixture directory',
        userData !== undefined && sameDirectory(userData, fixtureDir),
        JSON.stringify(userData) + ' vs ' + JSON.stringify(fixtureDir));
    check('the reported userData is not under the real userData directory',
        userData !== undefined && !isWithin(productionDir, userData), JSON.stringify(userData));

    check('the app opened the injected database path', f.SMOKE_DB === fixtureDb,
        JSON.stringify(f.SMOKE_DB) + ' vs ' + JSON.stringify(fixtureDb));
    check('the database is in WAL mode', f.SMOKE_JOURNAL_MODE === 'wal',
        'reported ' + JSON.stringify(f.SMOKE_JOURNAL_MODE));
    check('a row was written and read back', typeof f.SMOKE_ROW === 'string' && f.SMOKE_ROW.startsWith('smoke-'),
        'reported ' + JSON.stringify(f.SMOKE_ROW));
    check('the fixture database exists with a non-zero size', fixtureDbSize > 0,
        String(fixtureDbSize) + ' bytes at ' + fixtureDb);

    check('the renderer loaded and rendered "' + RENDERER_MARKER_TEXT + '"',
        typeof f.SMOKE_RENDERER_TEXT === 'string' && f.SMOKE_RENDERER_TEXT.includes(RENDERER_MARKER_TEXT),
        'reported ' + JSON.stringify(f.SMOKE_RENDERER_TEXT));
    check('the sandboxed preload exposed its bridge',
        typeof f.SMOKE_PRELOAD_VERSION === 'string' && f.SMOKE_PRELOAD_VERSION !== '',
        'reported ' + JSON.stringify(f.SMOKE_PRELOAD_VERSION));

    // WR-01: the page must not be able to leave its own CSP-bearing document.
    check('window.open from the page was refused and opened no window',
        f.SMOKE_WINDOW_OPEN_BLOCKED === 'true',
        'reported ' + JSON.stringify(f.SMOKE_WINDOW_OPEN_BLOCKED));
    check('a top-level navigation away from the renderer was refused',
        f.SMOKE_NAVIGATION_BLOCKED === 'true',
        'reported ' + JSON.stringify(f.SMOKE_NAVIGATION_BLOCKED));

    return checks;
}

/** D-37: what the bootstrap made of a fresh <userData>, judged from the SMOKE_* lines alone. */
export function evaluateFreshCase({ report }) {
    const f = report.fields;
    return [
        {
            label: 'the bootstrap classified the missing database as fresh',
            pass: f.SMOKE_DB_CLASS === 'fresh',
            detail: 'reported ' + JSON.stringify(f.SMOKE_DB_CLASS)
        },
        {
            label: 'the fresh database reached user_version ' + String(EXPECTED_LATEST),
            pass: f.SMOKE_DB_VERSION === String(EXPECTED_LATEST),
            detail: 'reported ' + JSON.stringify(f.SMOKE_DB_VERSION)
        },
        {
            label: 'a main window was created after the migration',
            pass: f.SMOKE_WINDOW_CREATED === 'true',
            detail: 'reported ' + JSON.stringify(f.SMOKE_WINDOW_CREATED)
        }
    ];
}

// src/lib/db/backup.ts's BACKUP_NAME, restated: `<database>.<ISO stamp, with : and . as ->.bak`.
const BACKUP_NAME = /^krono\.db\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/;

/** D-37/SC1: a v1.2.1-shaped file migrated in the packaged app, judged from what the harness read back. */
export function evaluateLegacyCase({ report, before, after, backups }) {
    const checks = [];
    const check = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail });
    const f = report.fields;

    check('the bootstrap classified the seeded database as legacy', f.SMOKE_DB_CLASS === 'legacy',
        'reported ' + JSON.stringify(f.SMOKE_DB_CLASS));
    check('nothing was refused', f.SMOKE_REPORT_KIND === undefined,
        'reported ' + JSON.stringify(f.SMOKE_REPORT_KIND ?? null));
    check('a main window was created after the migration', f.SMOKE_WINDOW_CREATED === 'true',
        'reported ' + JSON.stringify(f.SMOKE_WINDOW_CREATED));
    check('the migrated database reads user_version ' + String(EXPECTED_LATEST),
        after.userVersion === EXPECTED_LATEST, 'reads ' + String(after.userVersion));

    check('every work session survived', after.workSessions === before.workSessions,
        String(before.workSessions) + ' -> ' + String(after.workSessions));
    check('sum(duration) is unchanged', after.totalDuration === before.totalDuration,
        String(before.totalDuration) + ' -> ' + String(after.totalDuration));
    check('every company survived, plus Unassigned', after.companies === before.companies + 1,
        String(before.companies) + ' -> ' + String(after.companies));
    check('every pomodoro session survived', after.pomodoroSessions === before.pomodoroSessions,
        String(before.pomodoroSessions) + ' -> ' + String(after.pomodoroSessions));
    check('no seeded setting was dropped or rewritten',
        before.settings.every((row) => after.settingsByKey[row.key] === row.value),
        JSON.stringify(before.settings));

    check('an Unassigned company exists', after.unassignedCompanies === 1,
        String(after.unassignedCompanies) + ' rows named Unassigned');
    check('no work session is left without a company', after.nullCompanySessions === 0,
        String(after.nullCompanySessions) + ' sessions with a NULL company_id');

    const named = backups.filter((name) => BACKUP_NAME.test(name));
    check('exactly one verified-name backup was taken', backups.length === 1 && named.length === 1,
        JSON.stringify(backups));

    return checks;
}

/* ---------------------------------------------------------------------------------------- */
/* Fixture databases - built in Node with the same N-API prebuild the app loads               */
/* ---------------------------------------------------------------------------------------- */

// Synthetic rows only: no real company name, note or date ever reaches a fixture (D-01, D-03).
const LEGACY_ROWS = [
    "INSERT INTO companies (name, excel_column, note_column, note_required) VALUES ('Alpha Fixture', 'B', 'C', 0)",
    "INSERT INTO companies (name, excel_column, note_column, note_required) VALUES ('Beta Fixture', 'D', 'E', 1)",
    "INSERT INTO work_sessions (name, duration, date, company_id, note) VALUES ('Alpha Fixture', 3600, '2026-01-02', 1, 'synthetic')",
    "INSERT INTO work_sessions (name, duration, date, company_id, note) VALUES ('Beta Fixture', 1845, '2026-01-03', 2, NULL)",
    // The NULL-company session D-13 reassigns to Unassigned.
    "INSERT INTO work_sessions (name, duration, date, company_id, note) VALUES ('No Company', 900, '2026-01-04', NULL, NULL)",
    "INSERT INTO settings (key, value) VALUES ('fixtureMarker', 'kept-verbatim')",
    "INSERT INTO settings (key, value) VALUES ('dailyGoalHours', '7')",
    "INSERT INTO pomodoro_sessions (date, company_id, pomodoros_completed) VALUES ('2026-01-02', 1, 4)"
].join(';\n');

/** A v1.2.1-shaped krono.db at user_version 0, in WAL mode and checkpointed so the launch finds one file. */
export function seedLegacyDatabase(dbPath) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    try {
        db.pragma('journal_mode = WAL');
        db.exec(fs.readFileSync(V121_FIXTURE, 'utf8'));
        db.exec(LEGACY_ROWS);
        db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
        db.close();
    }
}

const count = (db, sql) => db.prepare(sql).get().n;

/** Counts and sums, read through a read-only connection so reading never writes. */
export function observeDatabase(dbPath) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {
        const settings = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
        const settingsByKey = {};
        for (const row of settings) settingsByKey[row.key] = row.value;
        return {
            userVersion: db.pragma('user_version', { simple: true }),
            companies: count(db, 'SELECT COUNT(*) AS n FROM companies'),
            workSessions: count(db, 'SELECT COUNT(*) AS n FROM work_sessions'),
            pomodoroSessions: count(db, 'SELECT COUNT(*) AS n FROM pomodoro_sessions'),
            totalDuration: db.prepare('SELECT COALESCE(SUM(duration), 0) AS n FROM work_sessions').get().n,
            unassignedCompanies: count(db, "SELECT COUNT(*) AS n FROM companies WHERE name = 'Unassigned'"),
            nullCompanySessions: count(db, 'SELECT COUNT(*) AS n FROM work_sessions WHERE company_id IS NULL'),
            settings,
            settingsByKey
        };
    } finally {
        db.close();
    }
}

/* ---------------------------------------------------------------------------------------- */
/* Process control                                                                            */
/* ---------------------------------------------------------------------------------------- */

// The same shape as tools/baseline/probe-userdata.mjs's killTree, which that module keeps private.
function killTree(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch {
        try {
            child.kill('SIGKILL');
        } catch {
            /* already gone */
        }
    }
}

/** One packaged launch against one temp userData directory. Never returns before the process is gone. */
export async function launchSmoke({ binary, userDataDir, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const { env: scrubbed, removed } = childEnvironment();
    const childEnv = { ...scrubbed, ...env };

    let stdout = '';
    let stderr = '';
    const exit = await new Promise((resolve) => {
        let timedOut = false;
        const child = spawn(binary, ['--smoke', '--user-data-dir=' + userDataDir], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: childEnv,
            detached: process.platform !== 'win32'
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        // Hard timeout backstop: nothing else guarantees a hung Electron process ever goes away.
        const backstop = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, timeoutMs);

        child.on('error', (error) => {
            clearTimeout(backstop);
            resolve({ code: null, signal: null, timedOut, error: error.message });
        });
        child.on('close', (code, signal) => {
            clearTimeout(backstop);
            resolve({ code, signal, timedOut });
        });
    });

    return { exit, stdout, stderr, childEnv, removed };
}

/* ---------------------------------------------------------------------------------------- */
/* The cases                                                                                  */
/* ---------------------------------------------------------------------------------------- */

/** A fresh mkdtemp userData, refused outright if the temp root somehow sits inside the real one (D-01, D-36). */
function makeFixtureDir(productionDir) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-smoke-'));
    const dir = path.join(root, 'ud');
    fs.mkdirSync(dir);
    if (isWithin(productionDir, dir)) {
        fs.rmSync(root, { recursive: true, force: true });
        throw new Error(SCRIPT_NAME + ': the fixture directory ' + dir +
            ' is inside the real userData directory ' + productionDir + '; refusing to launch');
    }
    return { root, dir };
}

async function freshCase({ binary, productionDir, timeoutMs, log }) {
    const { root, dir } = makeFixtureDir(productionDir);
    const fixtureDb = path.join(dir, SMOKE_DB_NAME);
    log(SCRIPT_NAME + ': [fresh] launching with --user-data-dir=' + dir);

    const launch = await launchSmoke({
        binary, userDataDir: dir, timeoutMs, env: { [SMOKE_DB_ENV]: fixtureDb }
    });
    const report = parseSmokeReport(launch.stdout);
    const fixtureDbSize = fs.existsSync(fixtureDb) ? fs.statSync(fixtureDb).size : 0;
    const checks = [
        ...evaluateSmoke({
            exit: launch.exit, report, childEnv: launch.childEnv, fixtureDir: dir, fixtureDb, fixtureDbSize,
            productionDir
        }),
        ...evaluateFreshCase({ report })
    ];
    if (launch.exit.error) checks.push({ label: 'the binary could be spawned', pass: false, detail: launch.exit.error });
    return { name: 'fresh', checks, launch, root, dir };
}

async function legacyCase({ binary, productionDir, timeoutMs, log }) {
    const { root, dir } = makeFixtureDir(productionDir);
    const dbPath = path.join(dir, DATABASE_FILE);
    seedLegacyDatabase(dbPath);
    const before = observeDatabase(dbPath);
    log(SCRIPT_NAME + ': [legacy] seeded a v1.2.1-shaped ' + DATABASE_FILE + ' at user_version ' +
        String(before.userVersion));

    const launch = await launchSmoke({
        binary, userDataDir: dir, timeoutMs, env: { [SMOKE_DB_ENV]: path.join(dir, SMOKE_DB_NAME) }
    });
    const report = parseSmokeReport(launch.stdout);
    const after = observeDatabase(dbPath);
    const backupDir = path.join(dir, BACKUP_DIR);
    const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];

    const checks = [
        {
            label: 'the packaged app exited 0',
            pass: launch.exit.code === 0,
            detail: 'code=' + String(launch.exit.code) + ' signal=' + String(launch.exit.signal) +
                (launch.exit.timedOut ? ' (killed by the hard timeout)' : '')
        },
        {
            label: 'stdout carried SMOKE_OK',
            pass: report.ok,
            detail: report.fields.SMOKE_FAIL ?? (report.ok ? 'present' : 'absent')
        },
        ...evaluateLegacyCase({ report, before, after, backups })
    ];
    if (launch.exit.error) checks.push({ label: 'the binary could be spawned', pass: false, detail: launch.exit.error });
    return { name: 'legacy', checks, launch, root, dir };
}

const CASES = { fresh: freshCase, legacy: legacyCase };

export async function runSmokeCases(options = {}) {
    const log = options.quiet ? () => {} : (...parts) => console.log(...parts);
    const distDir = path.resolve(options.distDir ?? path.join(repoRoot, 'dist'));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const binary = unpackedBinaryPath(distDir, process.platform, process.arch);
    if (!fs.existsSync(binary)) {
        return {
            ok: false,
            cases: [{
                name: 'build',
                checks: [{
                    label: 'an unpacked build exists',
                    pass: false,
                    detail: binary + ' is missing - run npm run build:unpack first'
                }]
            }]
        };
    }

    const productionDir = expectedProductionUserDataDir();
    const names = options.only ?? Object.keys(CASES);
    const results = [];
    for (const name of names) {
        const run = CASES[name];
        if (run === undefined) throw new Error(SCRIPT_NAME + ': no case named ' + name);
        const result = await run({ binary, productionDir, timeoutMs, log });
        results.push(result);
        if (options.keep) {
            log(SCRIPT_NAME + ': [' + name + '] fixture kept at ' + result.root);
        } else {
            try {
                // Chromium helper processes can hold a file open for a moment after the main process exits.
                fs.rmSync(result.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            } catch (error) {
                log(SCRIPT_NAME + ': could not remove ' + result.root + ': ' + error.message);
            }
        }
    }

    return { ok: results.every((r) => r.checks.every((c) => c.pass)), cases: results, binary };
}

/* ---------------------------------------------------------------------------------------- */
/* CLI                                                                                        */
/* ---------------------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const argv = process.argv.slice(2);
    const distArg = argv.find((a) => a.startsWith('--dist='));
    const caseArg = argv.find((a) => a.startsWith('--case='));
    let result;
    try {
        result = await runSmokeCases({
            keep: argv.includes('--keep'),
            distDir: distArg ? distArg.slice('--dist='.length) : undefined,
            only: caseArg ? caseArg.slice('--case='.length).split(',') : undefined
        });
    } catch (error) {
        console.error(SCRIPT_NAME + ': ' + error.message);
        process.exit(1);
    }

    let total = 0;
    let failed = 0;
    for (const c of result.cases) {
        console.log('--- case: ' + c.name + ' ---');
        for (const check of c.checks) {
            total += 1;
            if (!check.pass) failed += 1;
            console.log((check.pass ? 'PASS  ' : 'FAIL  ') + check.label + ' - ' + check.detail);
        }
    }
    console.log(SCRIPT_NAME + ': ' + String(total - failed) + '/' + String(total) + ' checks passed across ' +
        String(result.cases.length) + ' case(s)');

    if (!result.ok) {
        console.error(SCRIPT_NAME + ': the packaged smoke launch FAILED.');
        for (const c of result.cases) {
            if (c.launch?.stdout) console.error('--- [' + c.name + '] app stdout ---\n' + c.launch.stdout.trimEnd());
            if (c.launch?.stderr) console.error('--- [' + c.name + '] app stderr ---\n' + c.launch.stderr.trimEnd());
        }
        process.exit(1);
    }
    console.log('SMOKE_PACKAGED_OK');
    process.exit(0);
}

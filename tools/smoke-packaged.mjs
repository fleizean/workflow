#!/usr/bin/env node
// Launches the packaged build against a temporary userData directory and checks what it reports and leaves behind.
// Three launches, each one a question a user's first minute would answer:
//   fresh   a new install: does the app open a database, show Home and Settings, and play a sound?
//   legacy  an upgrade: is a v1.2.1 database migrated with nothing lost, and backed up first?
//   newer   a database from a future version: is it refused, untouched?
// The app side is src/main/smoke.ts, which prints SMOKE_* lines; this file only judges them.
// Usage: node tools/smoke-packaged.mjs [--keep] [--dist=PATH] [--case=fresh,legacy,newer]

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'tools/smoke-packaged.mjs';

/** package.json `name` - what Electron derives userData from. Never productName. */
export const EXPECTED_APP_NAME = 'workflow-timer';
/** electron-builder.yml productName - what the Windows and macOS executables are called. */
export const PRODUCT_NAME = 'Workflow';
export const SMOKE_DB_ENV = 'WORKFLOW_SMOKE_DB';
export const SMOKE_DB_NAME = 'smoke.db';
export const DEFAULT_TIMEOUT_MS = 90_000;
/** src/main/config.ts's RENDERER_MARKER_TEXT, and the second route's. */
export const RENDERER_MARKER_TEXT = 'Daily Target';
export const RENDERER_SECOND_ROUTE_TEXT = 'Settings';

/** src/main/database-startup.ts's DATABASE_FILE and BACKUP_DIR, and the migration registry's LATEST. */
export const DATABASE_FILE = 'krono.db';
export const BACKUP_DIR = 'backups';
export const EXPECTED_LATEST = 3;
/** src/main/config.ts's EXIT_CODES.refusedNewer. */
export const REFUSED_NEWER_EXIT_CODE = 4;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V121_FIXTURE = path.join(repoRoot, 'tests', 'fixtures', 'v121.sql');
const require = createRequire(import.meta.url);

/* ---------------------------------------------------------------------------------------- */
/* Where things are                                                                           */
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
    if (platform === 'linux') {
        // The executable is named after the package name, not productName.
        const dir = arch === 'x64' ? 'linux-unpacked' : 'linux-' + arch + '-unpacked';
        return path.join(distDir, dir, EXPECTED_APP_NAME);
    }
    throw new Error(SCRIPT_NAME + ': no packaged smoke launch is defined for ' + platform);
}

// The production userData directory: never touched, and no launch may resolve to it.
export function expectedProductionUserDataDir(platform = process.platform, home = os.homedir()) {
    if (platform === 'win32') {
        return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), EXPECTED_APP_NAME);
    }
    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', EXPECTED_APP_NAME);
    if (platform === 'linux') {
        return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), EXPECTED_APP_NAME);
    }
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
    const relative = path.relative(fold(parent), fold(child));
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/* ---------------------------------------------------------------------------------------- */
/* Judging a report                                                                           */
/* ---------------------------------------------------------------------------------------- */

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

const exitDetail = (exit) => 'code=' + String(exit.code) + ' signal=' + String(exit.signal) +
    (exit.timedOut ? ' (killed by the hard timeout)' : '');

/** What every launch that is meant to succeed must show: it exited cleanly, under the right name, in the right place. */
export function evaluateLaunch({ exit, report, fixtureDir }) {
    const f = report.fields;
    return [
        { label: 'the packaged app exited 0', pass: exit.code === 0, detail: exitDetail(exit) },
        { label: 'stdout carried SMOKE_OK', pass: report.ok, detail: f.SMOKE_FAIL ?? (report.ok ? 'present' : 'absent') },
        {
            label: 'the application name is ' + EXPECTED_APP_NAME,
            pass: f.SMOKE_APP_NAME === EXPECTED_APP_NAME,
            detail: 'reported ' + JSON.stringify(f.SMOKE_APP_NAME)
        },
        {
            label: 'userData was the temporary directory, not a real profile',
            pass: typeof f.SMOKE_USER_DATA === 'string' && isWithin(fixtureDir, f.SMOKE_USER_DATA),
            detail: 'reported ' + JSON.stringify(f.SMOKE_USER_DATA)
        }
    ];
}

/** The window half: Home and Settings rendered, and main's sound request became a decoded file from the bundle. */
export function evaluateWindow({ report }) {
    const f = report.fields;
    return [
        { label: 'a main window was created', pass: f.SMOKE_WINDOW_CREATED === 'true', detail: 'reported ' + JSON.stringify(f.SMOKE_WINDOW_CREATED) },
        { label: 'Home rendered "' + RENDERER_MARKER_TEXT + '"', pass: f.SMOKE_HOME_RENDERED === 'true', detail: 'reported ' + JSON.stringify(f.SMOKE_HOME_RENDERED) },
        { label: 'Settings rendered "' + RENDERER_SECOND_ROUTE_TEXT + '"', pass: f.SMOKE_SETTINGS_RENDERED === 'true', detail: 'reported ' + JSON.stringify(f.SMOKE_SETTINGS_RENDERED) },
        {
            label: 'a repository read worked through the bundled database layer',
            pass: Number(f.SMOKE_CONTAINER_TARGET) > 0,
            detail: 'dailyTarget=' + JSON.stringify(f.SMOKE_CONTAINER_TARGET)
        },
        {
            label: 'the sound was played from a file inside the app',
            pass: Number(f.SMOKE_SOUND_PLAYS) >= 1 && String(f.SMOKE_SOUND_SRC ?? '').startsWith('file:') &&
                String(f.SMOKE_SOUND_SRC ?? '').endsWith('.ogg'),
            detail: 'plays=' + JSON.stringify(f.SMOKE_SOUND_PLAYS) + ' src=' + JSON.stringify(f.SMOKE_SOUND_SRC)
        },
        {
            label: 'the sound decoded, so the bytes are really there',
            pass: f.SMOKE_SOUND_ERROR === '0' && Number(f.SMOKE_SOUND_DURATION) > 0,
            detail: 'mediaError=' + JSON.stringify(f.SMOKE_SOUND_ERROR) + ' duration=' + JSON.stringify(f.SMOKE_SOUND_DURATION)
        }
    ];
}

export function evaluateFreshCase({ report }) {
    const f = report.fields;
    return [
        { label: 'the bootstrap classified the database as fresh', pass: f.SMOKE_DB_CLASS === 'fresh', detail: 'reported ' + JSON.stringify(f.SMOKE_DB_CLASS) },
        {
            label: 'the fresh database reached user_version ' + String(EXPECTED_LATEST),
            pass: f.SMOKE_DB_VERSION === String(EXPECTED_LATEST),
            detail: 'reported ' + JSON.stringify(f.SMOKE_DB_VERSION)
        },
        ...evaluateWindow({ report })
    ];
}

// src/lib/db/backup.ts's BACKUP_NAME, restated: `<database>.<ISO stamp, with : and . as ->.bak`.
const BACKUP_NAME = /^krono\.db\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/;

/** A v1.2.1-shaped file migrated in the packaged app: nothing lost, one backup taken. */
export function evaluateLegacyCase({ report, before, after, backups }) {
    const f = report.fields;
    const named = backups.filter((name) => BACKUP_NAME.test(name));
    return [
        { label: 'the bootstrap classified the seeded database as legacy', pass: f.SMOKE_DB_CLASS === 'legacy', detail: 'reported ' + JSON.stringify(f.SMOKE_DB_CLASS) },
        { label: 'nothing was refused', pass: f.SMOKE_REPORT_KIND === undefined, detail: 'reported ' + JSON.stringify(f.SMOKE_REPORT_KIND ?? null) },
        { label: 'the migrated database reads user_version ' + String(EXPECTED_LATEST), pass: after.userVersion === EXPECTED_LATEST, detail: 'reads ' + String(after.userVersion) },
        { label: 'every work session survived', pass: after.workSessions === before.workSessions, detail: String(before.workSessions) + ' -> ' + String(after.workSessions) },
        { label: 'sum(duration) is unchanged', pass: after.totalDuration === before.totalDuration, detail: String(before.totalDuration) + ' -> ' + String(after.totalDuration) },
        { label: 'every company survived, plus Unassigned', pass: after.companies === before.companies + 1, detail: String(before.companies) + ' -> ' + String(after.companies) },
        { label: 'every pomodoro session survived', pass: after.pomodoroSessions === before.pomodoroSessions, detail: String(before.pomodoroSessions) + ' -> ' + String(after.pomodoroSessions) },
        { label: 'no work session is left without a company', pass: after.nullCompanySessions === 0, detail: String(after.nullCompanySessions) + ' with a NULL company_id' },
        { label: 'exactly one verified-name backup was taken', pass: backups.length === 1 && named.length === 1, detail: JSON.stringify(backups) },
        ...evaluateWindow({ report })
    ];
}

/** A newer database refused with no window, no write and no smoke database. */
export function evaluateRefusalCase({ exit, report, hashBefore, hashAfter, smokeDbExists }) {
    const f = report.fields;
    return [
        {
            label: 'the packaged app exited with the refused-newer code',
            pass: exit.code === REFUSED_NEWER_EXIT_CODE,
            detail: exitDetail(exit)
        },
        { label: 'the refusal was reported instead of a modal dialog', pass: f.SMOKE_REPORT_KIND === 'refused', detail: 'reported ' + JSON.stringify(f.SMOKE_REPORT_KIND ?? null) },
        { label: 'no window was ever created', pass: f.SMOKE_WINDOW_CREATED === undefined, detail: 'reported ' + JSON.stringify(f.SMOKE_WINDOW_CREATED ?? null) },
        { label: 'the database file is unchanged, byte for byte', pass: hashBefore === hashAfter, detail: String(hashBefore).slice(0, 16) + ' -> ' + String(hashAfter).slice(0, 16) },
        { label: 'no smoke database was created', pass: smokeDbExists === false, detail: smokeDbExists ? 'it exists' : 'absent' }
    ];
}

/** After a clean exit no -wal may be left holding rows the main file does not have. */
export function evaluateWalFlushed({ caseName, exists, size }) {
    return {
        label: '[' + caseName + '] ' + DATABASE_FILE + '-wal is absent or 0 bytes after the exit',
        pass: !exists || size === 0,
        detail: exists ? String(size) + ' bytes' : 'absent'
    };
}

/* ---------------------------------------------------------------------------------------- */
/* Fixture databases - built in Node with the same N-API prebuild the app loads               */
/* ---------------------------------------------------------------------------------------- */

// Synthetic rows only: no real company name, note or date ever reaches a fixture.
const LEGACY_ROWS = [
    "INSERT INTO companies (name, excel_column, note_column, note_required) VALUES ('Alpha Fixture', 'B', 'C', 0)",
    "INSERT INTO companies (name, excel_column, note_column, note_required) VALUES ('Beta Fixture', 'D', 'E', 1)",
    "INSERT INTO work_sessions (name, duration, date, company_id, note) VALUES ('Alpha Fixture', 3600, '2026-01-02', 1, 'synthetic')",
    "INSERT INTO work_sessions (name, duration, date, company_id, note) VALUES ('Beta Fixture', 1845, '2026-01-03', 2, NULL)",
    // The NULL-company session the migration reassigns to Unassigned.
    "INSERT INTO work_sessions (name, duration, date, company_id, note) VALUES ('No Company', 900, '2026-01-04', NULL, NULL)",
    "INSERT INTO settings (key, value) VALUES ('fixtureMarker', 'kept-verbatim')",
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

/** A single-table database from an imaginary future Workflow: classified `newer`, and refused untouched. */
export function seedNewerDatabase(dbPath, userVersion = 99) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    try {
        db.exec('CREATE TABLE from_the_future (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
        db.pragma('user_version = ' + String(userVersion));
    } finally {
        db.close();
    }
}

export function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const count = (db, sql) => db.prepare(sql).get().n;

/** Counts and sums, read through a read-only connection so reading never writes. */
export function observeDatabase(dbPath) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {
        return {
            userVersion: db.pragma('user_version', { simple: true }),
            companies: count(db, 'SELECT COUNT(*) AS n FROM companies'),
            workSessions: count(db, 'SELECT COUNT(*) AS n FROM work_sessions'),
            pomodoroSessions: count(db, 'SELECT COUNT(*) AS n FROM pomodoro_sessions'),
            totalDuration: db.prepare('SELECT COALESCE(SUM(duration), 0) AS n FROM work_sessions').get().n,
            nullCompanySessions: count(db, 'SELECT COUNT(*) AS n FROM work_sessions WHERE company_id IS NULL')
        };
    } finally {
        db.close();
    }
}

/* ---------------------------------------------------------------------------------------- */
/* Process control                                                                            */
/* ---------------------------------------------------------------------------------------- */

/*
 * The environment a launch gets. ELECTRON_RUN_AS_NODE would make the binary behave as plain Node and NODE_OPTIONS
 * would change it, so both are removed; WORKFLOW_NO_UPDATE_CHECK keeps a smoke run off the network.
 */
export const SCRUBBED_ENV = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'];

function childEnvironment(extra) {
    const env = { ...process.env, WORKFLOW_NO_UPDATE_CHECK: '1', ...extra };
    for (const name of SCRUBBED_ENV) delete env[name];
    return env;
}

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
    let stdout = '';
    let stderr = '';
    const exit = await new Promise((resolve) => {
        let timedOut = false;
        const child = spawn(binary, ['--smoke', '--user-data-dir=' + userDataDir], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: childEnvironment(env),
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
    return { exit, stdout, stderr };
}

/* ---------------------------------------------------------------------------------------- */
/* The cases                                                                                  */
/* ---------------------------------------------------------------------------------------- */

/** A fresh mkdtemp userData, refused outright if the temp root somehow sits inside the real one. */
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

function walCheck(caseName, userDataDir) {
    const wal = path.join(userDataDir, DATABASE_FILE + '-wal');
    const exists = fs.existsSync(wal);
    return evaluateWalFlushed({ caseName, exists, size: exists ? fs.statSync(wal).size : 0 });
}

const spawnCheck = (launch) => launch.exit.error
    ? [{ label: 'the binary could be spawned', pass: false, detail: launch.exit.error }]
    : [];

async function freshCase({ binary, productionDir, timeoutMs, log }) {
    const { root, dir } = makeFixtureDir(productionDir);
    log(SCRIPT_NAME + ': [fresh] launching with --user-data-dir=' + dir);
    const launch = await launchSmoke({
        binary, userDataDir: dir, timeoutMs, env: { [SMOKE_DB_ENV]: path.join(dir, SMOKE_DB_NAME) }
    });
    const report = parseSmokeReport(launch.stdout);
    const checks = [
        ...evaluateLaunch({ exit: launch.exit, report, fixtureDir: dir }),
        ...evaluateFreshCase({ report }),
        walCheck('fresh', dir),
        ...spawnCheck(launch)
    ];
    return { name: 'fresh', checks, launch, root, dir };
}

async function legacyCase({ binary, productionDir, timeoutMs, log }) {
    const { root, dir } = makeFixtureDir(productionDir);
    const dbPath = path.join(dir, DATABASE_FILE);
    seedLegacyDatabase(dbPath);
    const before = observeDatabase(dbPath);
    log(SCRIPT_NAME + ': [legacy] seeded a v1.2.1-shaped ' + DATABASE_FILE + ' at user_version ' + String(before.userVersion));

    const launch = await launchSmoke({
        binary, userDataDir: dir, timeoutMs, env: { [SMOKE_DB_ENV]: path.join(dir, SMOKE_DB_NAME) }
    });
    const report = parseSmokeReport(launch.stdout);
    const after = observeDatabase(dbPath);
    const backupDir = path.join(dir, BACKUP_DIR);
    const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    const checks = [
        ...evaluateLaunch({ exit: launch.exit, report, fixtureDir: dir }),
        ...evaluateLegacyCase({ report, before, after, backups }),
        walCheck('legacy', dir),
        ...spawnCheck(launch)
    ];
    return { name: 'legacy', checks, launch, root, dir };
}

async function newerCase({ binary, productionDir, timeoutMs, log }) {
    const { root, dir } = makeFixtureDir(productionDir);
    const dbPath = path.join(dir, DATABASE_FILE);
    const smokeDb = path.join(dir, SMOKE_DB_NAME);
    seedNewerDatabase(dbPath);
    const hashBefore = sha256(dbPath);
    log(SCRIPT_NAME + ': [newer] seeded a ' + DATABASE_FILE + ' at user_version 99');

    const launch = await launchSmoke({ binary, userDataDir: dir, timeoutMs, env: { [SMOKE_DB_ENV]: smokeDb } });
    const report = parseSmokeReport(launch.stdout);
    const checks = [
        ...evaluateRefusalCase({
            exit: launch.exit, report, hashBefore, hashAfter: sha256(dbPath), smokeDbExists: fs.existsSync(smokeDb)
        }),
        ...spawnCheck(launch)
    ];
    return { name: 'newer', checks, launch, root, dir };
}

const CASES = { fresh: freshCase, legacy: legacyCase, newer: newerCase };

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
                checks: [{ label: 'an unpacked build exists', pass: false, detail: binary + ' is missing - run npm run build:unpack first' }]
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

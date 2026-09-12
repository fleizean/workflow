#!/usr/bin/env node
// D-35 item 3: carry a timerState written by the real v1.2.1 (Electron 28) into the new build's database (Electron 44).
// Mode v121 touches real files and refuses without --owner-approved=continuity; mode new-build is a dry run that does not.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { childEnvironment, resolveLaunch } from '../baseline/probe-userdata.mjs';
import {
    DATABASE_FILE,
    LEGACY_TIMER_KEY,
    SMOKE_DB_ENV,
    SMOKE_DB_NAME,
    SMOKE_SEED_TIMER_STATE_ENV,
    expectedProductionUserDataDir,
    isWithin,
    launchSmoke,
    unpackedBinaryPath
} from '../smoke-packaged.mjs';

const SCRIPT_NAME = 'tools/db/legacy-timer-proof.mjs';

export const MODES = ['v121', 'new-build'];
export const OWNER_TOKEN = 'continuity';
/** v1.2.1's start control (src/pages/index.html:444) and the key its saveTimerState writes every second. */
export const START_SELECTOR = '#playPauseButton';
export const TIMER_STATE_KEY = 'timerState';
export const DEFAULT_TIMEOUT_MS = 90_000;
/** Long enough for v1.2.1's per-second save to have written at least two ticks. */
export const RUN_MS = 3000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(repoRoot, 'baselines', 'v1.2.1', 'MANIFEST.md');
const require = createRequire(import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------------------------------- */
/* Pure guards                                                                                */
/* ---------------------------------------------------------------------------------------- */

/** `--mode=`, `--hard-kill`, `--owner-approved=` (kept verbatim). An unknown argument throws rather than being ignored. */
export function parseProofArgs(argv = []) {
    let mode = null;
    let hardKill = false;
    let ownerApproved = null;
    for (const arg of argv) {
        if (arg === '--hard-kill') {
            hardKill = true;
        } else if (arg.startsWith('--mode=')) {
            mode = arg.slice('--mode='.length);
            if (!MODES.includes(mode)) {
                throw new Error(SCRIPT_NAME + ': unknown --mode=' + mode + '; expected one of ' + MODES.join(', '));
            }
        } else if (arg.startsWith('--owner-approved=')) {
            ownerApproved = arg.slice('--owner-approved='.length);
        } else {
            throw new Error(SCRIPT_NAME + ': unrecognized argument ' + JSON.stringify(arg));
        }
    }
    return { mode, hardKill, ownerApproved };
}

/** The MANIFEST.md section 4 rows that pin the archived app. */
export const PINNED_FILES = ['Workflow.exe', 'resources/app.asar'];

export function parseManifestPins(markdown) {
    const pins = {};
    const row = /^\|\s*`([^`]+)`\s*\|\s*([\d,]+)\s*\|\s*`([0-9a-fA-F]{64})`\s*\|/gm;
    let match = row.exec(markdown);
    while (match !== null) {
        pins[match[1]] = { bytes: Number(match[2].replace(/,/g, '')), sha256: match[3].toLowerCase() };
        match = row.exec(markdown);
    }
    return pins;
}

/** Every pinned file must match its recorded size and digest; any mismatch throws naming the file. */
export function verifyArchivedAppPins(manifestMarkdown, readFile) {
    const pins = parseManifestPins(manifestMarkdown);
    const verified = [];
    for (const file of PINNED_FILES) {
        const pin = pins[file];
        if (pin === undefined) {
            throw new Error(SCRIPT_NAME + ': ' + file + ' has no SHA-256 pin in baselines/v1.2.1/MANIFEST.md');
        }
        const bytes = readFile(file);
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        if (bytes.length !== pin.bytes) {
            throw new Error(SCRIPT_NAME + ': ' + file + ' is ' + String(bytes.length) +
                ' bytes; the manifest pins ' + String(pin.bytes));
        }
        if (sha256 !== pin.sha256) {
            throw new Error(SCRIPT_NAME + ': ' + file + ' does not match its manifest pin (' +
                sha256.slice(0, 16) + ' vs ' + pin.sha256.slice(0, 16) + ')');
        }
        verified.push({ file, bytes: bytes.length, sha256 });
    }
    return verified;
}

/** A launch target must be a temp directory, and must never resolve inside the production userData (D-01, D-02). */
export function assertTempUserData(dir, productionDir) {
    if (!isWithin(os.tmpdir(), dir)) {
        throw new Error(SCRIPT_NAME + ': ' + dir + ' is not under ' + os.tmpdir() + '; refusing to launch');
    }
    if (isWithin(productionDir, dir)) {
        throw new Error(SCRIPT_NAME + ': ' + dir + ' is inside the production userData directory ' +
            productionDir + '; refusing to launch');
    }
    return dir;
}

/** The elapsed v1.2.1 saved, floored: the import may never invent time (B12). */
export function elapsedOf(raw) {
    const parsed = JSON.parse(raw);
    const elapsed = Number(parsed.elapsed);
    if (!Number.isFinite(elapsed)) throw new Error(SCRIPT_NAME + ': the saved timerState carries no numeric elapsed');
    return { elapsedSeconds: Math.floor(elapsed), running: parsed.running === true };
}

/* ---------------------------------------------------------------------------------------- */
/* The real dependencies                                                                      */
/* ---------------------------------------------------------------------------------------- */

export function hashFile(file) {
    if (!fs.existsSync(file)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function killTree(pid) {
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch {
        /* already gone */
    }
}

function defaultVerifyPins() {
    const launch = resolveLaunch();
    const appDir = path.dirname(launch.executable);
    return verifyArchivedAppPins(
        fs.readFileSync(manifestPath, 'utf8'),
        (rel) => fs.readFileSync(path.join(appDir, ...rel.split('/')))
    );
}

/*
 * Launch the archived v1.2.1, start its timer through its own page, and return what it saved.
 * With hardKill the process tree dies mid-run and nothing is read from the page: whether the key
 * survived is then the new build's answer, not ours (research A4).
 */
async function defaultLaunchElectron({ executable, args, userDataDir, hardKill, timeoutMs, log }) {
    const { _electron: electron } = await import('playwright-core');
    const { env, removed } = childEnvironment();
    if (removed.length > 0) log(SCRIPT_NAME + ': scrubbed from the child environment -> ' + removed.join(', '));

    const app = await electron.launch({
        executablePath: executable,
        args: [...args, '--user-data-dir=' + userDataDir],
        env,
        timeout: timeoutMs
    });
    const pid = app.process().pid;
    let raw = null;
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState('load');
        await page.click(START_SELECTOR);
        await sleep(RUN_MS);
        if (!hardKill) {
            raw = await page.evaluate((key) => globalThis.localStorage.getItem(key), TIMER_STATE_KEY);
        }
    } finally {
        if (!hardKill) {
            try {
                await Promise.race([
                    app.evaluate(({ app: electronApp }) => electronApp.exit(0)),
                    sleep(10_000)
                ]);
            } catch {
                /* the process may already be gone; the kill below settles it either way */
            }
        }
        killTree(pid);
        for (let i = 0; i < 50 && app.process().exitCode === null; i += 1) await sleep(100);
    }
    return { raw };
}

/** What the new build imported, read through a read-only connection so reading never writes. */
export function observeImport(dbPath) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(LEGACY_TIMER_KEY);
        return {
            stored: row === undefined ? null : JSON.parse(row.value),
            workSessions: db.prepare('SELECT COUNT(*) AS n FROM work_sessions').get().n
        };
    } finally {
        db.close();
    }
}

const REAL_DEPS = {
    resolveLaunch,
    verifyPins: defaultVerifyPins,
    launchElectron: defaultLaunchElectron,
    launchSmoke,
    hashFile,
    readFile: (file) => fs.readFileSync(file),
    observeImport,
    log: (line) => console.log(line)
};

/* ---------------------------------------------------------------------------------------- */
/* The proof                                                                                  */
/* ---------------------------------------------------------------------------------------- */

function makeUserDataDir(productionDir) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-continuity-'));
    const dir = path.join(root, 'ud');
    fs.mkdirSync(dir);
    try {
        assertTempUserData(dir, productionDir);
    } catch (error) {
        fs.rmSync(root, { recursive: true, force: true });
        throw error;
    }
    return { root, dir };
}

function removeDir(root) {
    try {
        // Chromium helper processes can hold a file open for a moment after the main process exits.
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
        /* the caller's own hash checks are what judge the run */
    }
}

// The dry run's synthetic seed: a running record whose lastUpdated is a day old, so invented time is visible.
export function dryRunSeed() {
    const elapsedSeconds = 2571;
    return {
        elapsedSeconds,
        raw: JSON.stringify({
            elapsed: elapsedSeconds,
            running: true,
            pomodoroMode: false,
            pomodoroState: 'work',
            pomodoroSessionCount: 0,
            lastUpdated: Date.now() - 24 * 60 * 60 * 1000
        })
    };
}

/*
 * Mode v121 is the real proof and is refused without the owner's token; mode new-build is its own
 * path, which never resolves the archive, never hashes the live database and prints no LIVE_HASH line.
 */
export async function runContinuityProof(options = {}, deps = {}) {
    const log = deps.log ?? REAL_DEPS.log;
    if (options.mode === 'v121' && options.ownerApproved !== OWNER_TOKEN) {
        log('REAL_DATA_PROOF_REFUSED continuity');
        log(SCRIPT_NAME + ': mode v121 runs only with --owner-approved=' + OWNER_TOKEN +
            ', and only for a proof the owner approved at the D-01 door.');
        return { ok: false, code: 2, refused: true };
    }
    if (!MODES.includes(options.mode)) {
        log(SCRIPT_NAME + ': --mode is required; expected one of ' + MODES.join(', '));
        return { ok: false, code: 1 };
    }

    const d = { ...REAL_DEPS, ...deps, log };
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const productionDir = options.productionDir ?? expectedProductionUserDataDir();
    const binary = options.binary ?? unpackedBinaryPath(
        path.resolve(options.distDir ?? path.join(repoRoot, 'dist')), process.platform, process.arch
    );

    return options.mode === 'v121'
        ? await runV121(options, d, { timeoutMs, productionDir, binary })
        : await runNewBuild(options, d, { timeoutMs, productionDir, binary });
}

async function importWithNewBuild(d, { binary, dir, timeoutMs }) {
    const launch = await d.launchSmoke({
        binary,
        userDataDir: dir,
        timeoutMs,
        env: { [SMOKE_DB_ENV]: path.join(dir, SMOKE_DB_NAME) }
    });
    if (launch.exit?.error) {
        throw new Error(SCRIPT_NAME + ': could not launch ' + binary + ' (' + launch.exit.error +
            '); run npm run build:unpack first');
    }
    if (launch.exit?.code !== 0) {
        throw new Error(SCRIPT_NAME + ': the new build exited ' + String(launch.exit?.code) + ' on the import launch');
    }
    return d.observeImport(path.join(dir, DATABASE_FILE));
}

// Lengths, equality booleans and the synthetic elapsed only: no timerState contents are ever printed.
function reportImport(log, { expectedRaw, expectedElapsed, observed }) {
    const stored = observed.stored;
    const rawEqual = stored !== null && stored !== undefined && stored.raw === expectedRaw;
    const elapsedEqual = stored !== null && stored !== undefined && stored.elapsedSeconds === expectedElapsed;
    log('RAW_LENGTH=' + String(expectedRaw.length) + ' STORED_RAW_LENGTH=' + String(stored?.raw?.length ?? 0));
    log('RAW_EQUAL=' + String(rawEqual));
    log('ELAPSED_SECONDS=' + String(expectedElapsed) + ' STORED_ELAPSED_SECONDS=' + String(stored?.elapsedSeconds));
    log('ELAPSED_EQUAL=' + String(elapsedEqual));
    log('WORK_SESSIONS=' + String(observed.workSessions));
    return rawEqual && elapsedEqual && observed.workSessions === 0;
}

async function runV121(options, d, { timeoutMs, productionDir, binary }) {
    const log = d.log;
    const liveDb = path.join(productionDir, DATABASE_FILE);
    const label = options.hardKill === true ? 'continuity-hard-kill' : 'continuity';

    const before = d.hashFile(liveDb);
    log('LIVE_HASH_BEFORE=' + (before ?? 'absent'));

    let passed = false;
    let created = null;
    try {
        for (const pin of d.verifyPins() ?? []) {
            log('ARCHIVED_PIN_OK ' + pin.file + ' ' + String(pin.bytes) + ' bytes');
        }

        const launch = d.resolveLaunch();
        created = makeUserDataDir(productionDir);
        log(SCRIPT_NAME + ': launching the archived v1.2.1 with --user-data-dir=' + created.dir);

        const written = await d.launchElectron({
            executable: launch.executable,
            args: launch.args,
            userDataDir: created.dir,
            hardKill: options.hardKill === true,
            timeoutMs,
            log
        });

        if (options.hardKill === true) {
            const observed = await importWithNewBuild(d, { binary, dir: created.dir, timeoutMs });
            const survived = observed.stored !== null && observed.stored !== undefined;
            // Recorded, never judged: Chromium may lose the last write of an abruptly killed app (research A4).
            log('HARD_KILL_KEY_SURVIVED=' + String(survived));
            log('WORK_SESSIONS=' + String(observed.workSessions));
            passed = observed.workSessions === 0;
        } else {
            const expectedRaw = written.raw;
            if (typeof expectedRaw !== 'string' || expectedRaw.length === 0) {
                throw new Error(SCRIPT_NAME + ': v1.2.1 saved no ' + TIMER_STATE_KEY + ' while its timer ran');
            }
            const saved = elapsedOf(expectedRaw);
            if (!saved.running) throw new Error(SCRIPT_NAME + ': the saved timerState is not running');
            if (saved.elapsedSeconds < 2) {
                throw new Error(SCRIPT_NAME + ': the saved elapsed is ' + String(saved.elapsedSeconds) + 's, below 2s');
            }
            const observed = await importWithNewBuild(d, { binary, dir: created.dir, timeoutMs });
            passed = reportImport(log, { expectedRaw, expectedElapsed: saved.elapsedSeconds, observed });
        }
    } catch (error) {
        log(SCRIPT_NAME + ': FAILED - ' + error.message);
        passed = false;
    } finally {
        if (created) removeDir(created.root);
    }

    const after = d.hashFile(liveDb);
    log('LIVE_HASH_AFTER=' + (after ?? 'absent'));
    const untouched = before === after;
    if (!untouched) log(SCRIPT_NAME + ': the live database changed during the proof');
    if (passed && untouched) {
        log('REAL_DATA_PROOF_PASS ' + label);
        return { ok: true, code: 0 };
    }
    return { ok: false, code: 1 };
}

async function runNewBuild(options, d, { timeoutMs, productionDir, binary }) {
    const log = d.log;
    const seed = dryRunSeed();
    let passed = false;
    let created = null;
    try {
        created = makeUserDataDir(productionDir);
        log(SCRIPT_NAME + ': [new-build] seeding ' + TIMER_STATE_KEY + ' through the new build in ' + created.dir);

        const seedLaunch = await d.launchSmoke({
            binary,
            userDataDir: created.dir,
            timeoutMs,
            env: { [SMOKE_DB_ENV]: path.join(created.dir, SMOKE_DB_NAME), [SMOKE_SEED_TIMER_STATE_ENV]: seed.raw }
        });
        if (seedLaunch.exit?.error) {
            throw new Error(SCRIPT_NAME + ': could not launch ' + binary + ' (' + seedLaunch.exit.error +
                '); run npm run build:unpack first');
        }
        if (seedLaunch.exit?.code !== 0) {
            throw new Error(SCRIPT_NAME + ': the seed launch exited ' + String(seedLaunch.exit?.code));
        }

        const observed = await importWithNewBuild(d, { binary, dir: created.dir, timeoutMs });
        passed = reportImport(log, { expectedRaw: seed.raw, expectedElapsed: seed.elapsedSeconds, observed });
    } catch (error) {
        log(SCRIPT_NAME + ': FAILED - ' + error.message);
        passed = false;
    } finally {
        if (created) removeDir(created.root);
    }

    if (passed) {
        log('CONTINUITY_DRY_RUN_PASS');
        return { ok: true, code: 0 };
    }
    return { ok: false, code: 1 };
}

/* ---------------------------------------------------------------------------------------- */
/* CLI                                                                                        */
/* ---------------------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    let result;
    try {
        result = await runContinuityProof(parseProofArgs(process.argv.slice(2)));
    } catch (error) {
        console.error(SCRIPT_NAME + ': ' + error.message);
        process.exit(1);
    }
    process.exit(result.code);
}

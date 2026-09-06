#!/usr/bin/env node
/*
 * CUSTODY-10 - prove, by execution, that a launched v1.2.1 reads a fixture database and not the
 * owner's real one.
 *
 * This file exists because of research assumption A1. `database/db.js:9-10` opens the database at
 * module load:
 *
 *     const dbPath = path.join(app.getPath('userData'), 'krono.db');
 *     const db = new Database(dbPath);
 *
 * `main.js:6` requires that module at the top of the file, so no application JavaScript runs
 * earlier and no in-app hook can redirect it. The only mechanism below the JS layer is Electron's
 * `--user-data-dir` switch, applied by ElectronMainDelegate::PreSandboxStartup() before the main
 * module is evaluated (read from electron @ v28.3.3, shell/app/electron_main_delegate.cc:318-327).
 * That was read, never executed - the checked-in Electron binary was a Linux ELF at the time.
 *
 * If the switch silently does nothing, the baseline capture renders the owner's real client names
 * and real work notes into PNGs that are then committed to a public repository. That is a D-03
 * violation which cannot be undone. So the mechanism is probed, and the probe is a hard gate that
 * tools/baseline/capture.mjs calls before it is structurally able to take a screenshot.
 *
 * The probe asserts four things, and any one of them failing is a refusal:
 *
 *   1. the fixture directory now contains a krono.db;
 *   2. the real %APPDATA%\workflow-timer\krono.db is unchanged in size, mtime and SHA-256;
 *   3. its -wal and -shm sidecars are unchanged too - in WAL mode a write lands in the sidecar
 *      first, so checking only the main file can miss a touch entirely;
 *   4. the fixture krono.db is not a byte-copy of the real one.
 *
 * Shutdown is a hard kill of the process tree, not a window-close request. main.js:70-72 calls
 * event.preventDefault() and hides to the tray unless the tray Quit item set isQuiting, so a close
 * request hangs with no diagnostic (research pitfall 4). capture.mjs, which has Playwright and can
 * reach the main process, uses app.exit(0); this probe deliberately carries no automation
 * dependency so that it can run before playwright-core is installed, and a SIGKILL against a
 * throwaway fixture costs nothing.
 *
 * Usage:
 *   node tools/baseline/probe-userdata.mjs            probe, print a report, exit 0 or 1
 *   node tools/baseline/probe-userdata.mjs --keep     leave the fixture directory on disk
 *   node tools/baseline/probe-userdata.mjs --exe=PATH override the manifest-recorded executable
 *
 * Environment:
 *   WFT_V121_EXE       absolute path to the v1.2.1 executable (overrides the manifest)
 *   WFT_V121_ARGS      space-separated launch arguments (overrides the manifest)
 *   WFT_REAL_USERDATA  userData directory to protect (default: %APPDATA%\workflow-timer)
 */

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'tools/baseline/probe-userdata.mjs';
const DB_NAME = 'krono.db';
const GUARDED = [DB_NAME, 'krono.db-wal', 'krono.db-shm'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(repoRoot, 'baselines', 'v1.2.1', 'MANIFEST.md');

/* ---------------------------------------------------------------------------------------- */
/* Launch-path resolution                                                                    */
/* ---------------------------------------------------------------------------------------- */

/*
 * The manifest is a public file, so it records the executable with %USERPROFILE% left unexpanded
 * rather than baking the owner's Windows account name into a public repository - the same
 * reasoning section 2 already applies to the real-database archive location. Expansion happens
 * here, at the point of use.
 */
export function expandEnvVars(value) {
    return value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
        const resolved = process.env[name];
        if (!resolved) {
            throw new Error(manifestPath + ' references ' + whole + ' but that variable is not set');
        }
        return resolved;
    });
}

function manifestField(markdown, label) {
    const row = new RegExp('^\\|\\s*' + label + '\\s*\\|\\s*`([^`]*)`\\s*\\|', 'im');
    const match = markdown.match(row);
    return match ? match[1].trim() : null;
}

/*
 * Resolve which v1.2.1 to launch. Phase 8 has to reproduce this exact launch path months from now,
 * which is why the answer lives in the manifest rather than in this script.
 */
export function resolveLaunch() {
    const fromEnv = process.env.WFT_V121_EXE;
    if (fromEnv) {
        return {
            source: 'WFT_V121_EXE',
            path: 'env-override',
            executable: path.resolve(expandEnvVars(fromEnv)),
            args: (process.env.WFT_V121_ARGS ?? '--no-sandbox').split(' ').filter(Boolean)
        };
    }
    if (!fs.existsSync(manifestPath)) {
        throw new Error(manifestPath + ' is missing; it records which v1.2.1 to launch');
    }
    const markdown = fs.readFileSync(manifestPath, 'utf8');
    const executable = manifestField(markdown, 'Executable');
    if (!executable) {
        throw new Error(
            manifestPath + ' has no "Executable" row in its capture-provenance section. ' +
            'Plan 01-05 task 1 records it there; without it there is nothing to launch.'
        );
    }
    const args = manifestField(markdown, 'Launch args');
    return {
        source: 'MANIFEST.md',
        path: manifestField(markdown, 'Launch path') ?? 'unrecorded',
        executable: path.resolve(expandEnvVars(executable)),
        args: (args ?? '--no-sandbox').split(' ').filter(Boolean)
    };
}

/* ---------------------------------------------------------------------------------------- */
/* Fingerprinting the file this whole phase exists to protect                                 */
/* ---------------------------------------------------------------------------------------- */

export function realUserDataDir() {
    if (process.env.WFT_REAL_USERDATA) return path.resolve(process.env.WFT_REAL_USERDATA);
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'workflow-timer');
}

export function fingerprint(file) {
    if (!fs.existsSync(file)) return { present: false };
    const stat = fs.statSync(file);
    return {
        present: true,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mtimeISO: new Date(stat.mtimeMs).toISOString(),
        sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    };
}

export function fingerprintAll(dir) {
    const out = {};
    for (const name of GUARDED) out[name] = fingerprint(path.join(dir, name));
    return out;
}

export function describe(fp) {
    return fp.present ? fp.size + ' bytes, mtime ' + fp.mtimeISO + ', sha256 ' + fp.sha256 : 'absent';
}

export function differences(before, after) {
    const changed = [];
    for (const name of GUARDED) {
        const a = before[name];
        const b = after[name];
        if (a.present !== b.present) {
            changed.push(name + ': ' + (a.present ? 'existed and is now gone' : 'did not exist and now does'));
            continue;
        }
        if (!a.present) continue;
        if (a.size !== b.size) changed.push(name + ': size ' + a.size + ' -> ' + b.size);
        if (a.mtimeMs !== b.mtimeMs) changed.push(name + ': mtime ' + a.mtimeISO + ' -> ' + b.mtimeISO);
        if (a.sha256 !== b.sha256) changed.push(name + ': sha256 ' + a.sha256 + ' -> ' + b.sha256);
    }
    return changed;
}

/* ---------------------------------------------------------------------------------------- */
/* Process control                                                                            */
/* ---------------------------------------------------------------------------------------- */

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

function findFile(dir, name, depth = 4) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        if (entry.isFile() && entry.name === name) return path.join(dir, entry.name);
    }
    if (depth <= 0) return null;
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const hit = findFile(path.join(dir, entry.name), name, depth - 1);
        if (hit) return hit;
    }
    return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Variables that must not reach a launched Electron. This is not hygiene theatre - it was found by
 * this probe failing.
 *
 * ELECTRON_RUN_AS_NODE=1 was present in the ambient environment of the session that first ran the
 * probe (a leftover from plan 01-02, which used it to prove electron.exe executes at all). With it
 * set, electron.exe boots as plain Node instead of as Chromium, Node's own option parser sees
 * --no-sandbox, prints "bad option: --no-sandbox" and exits 9. The failure looks exactly like a
 * failed --user-data-dir redirection: no window, no krono.db, no diagnostic beyond an exit code.
 * A capture harness that inherits it silently produces nothing; worse, a future variant that
 * ignored the exit code could conclude the app "did not create a fixture database" and be tempted
 * to relax the gate.
 *
 * NODE_OPTIONS is scrubbed for the same class of reason: Electron honours it, and an injected flag
 * would change the runtime the baseline is captured against.
 */
export const SCRUBBED_ENV = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'];

export function childEnvironment(base = process.env) {
    const env = { ...base };
    const removed = [];
    for (const name of SCRUBBED_ENV) {
        if (env[name] !== undefined) {
            delete env[name];
            removed.push(name);
        }
    }
    return { env, removed };
}

/* ---------------------------------------------------------------------------------------- */
/* The probe                                                                                  */
/* ---------------------------------------------------------------------------------------- */

export async function probeUserDataRedirection(options = {}) {
    const quiet = options.quiet ?? false;
    const log = quiet ? () => {} : (...parts) => console.log(...parts);
    const timeoutMs = options.timeoutMs ?? 90000;
    const keep = options.keep ?? false;
    const launch = options.launch ?? resolveLaunch();

    if (!fs.existsSync(launch.executable)) {
        return {
            ok: false,
            failures: ['the recorded v1.2.1 executable does not exist: ' + launch.executable],
            launch
        };
    }

    const realDir = realUserDataDir();
    const before = fingerprintAll(realDir);

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-probe-'));
    const fixtureDir = path.join(fixtureRoot, 'ud');
    fs.mkdirSync(fixtureDir, { recursive: true });

    log(SCRIPT_NAME + ': launching ' + launch.executable);
    log(SCRIPT_NAME + ':   --user-data-dir=' + fixtureDir);
    log(SCRIPT_NAME + ': real ' + path.join(realDir, DB_NAME) + ' before -> ' + describe(before[DB_NAME]));

    let child = null;
    let fixtureDb = null;
    let exitInfo = null;
    let backstop = null;

    const { env, removed } = childEnvironment();
    if (removed.length > 0) {
        log(SCRIPT_NAME + ': scrubbed from the child environment -> ' + removed.join(', '));
    }

    try {
        child = spawn(launch.executable, [...launch.args, '--user-data-dir=' + fixtureDir], {
            stdio: 'ignore',
            windowsHide: true,
            env,
            detached: process.platform !== 'win32'
        });
        child.on('exit', (code, signal) => {
            exitInfo = { code, signal };
        });

        // Hard timeout backstop: the app hides to the tray rather than quitting, so nothing else
        // guarantees this process ever goes away.
        backstop = setTimeout(() => killTree(child), timeoutMs);

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            fixtureDb = findFile(fixtureDir, DB_NAME);
            if (fixtureDb && fs.statSync(fixtureDb).size > 0) break;
            if (exitInfo) break;
            await sleep(250);
        }
        // Let initDatabase() finish its ALTER TABLE migrations against the fixture before the kill.
        if (fixtureDb) await sleep(1500);
    } finally {
        if (backstop) clearTimeout(backstop);
        killTree(child);
        for (let i = 0; i < 40 && child && child.exitCode === null && child.signalCode === null; i += 1) {
            await sleep(100);
        }
    }

    const after = fingerprintAll(realDir);
    const failures = [];

    if (!fixtureDb) {
        failures.push(
            'no ' + DB_NAME + ' appeared under the fixture directory within ' + timeoutMs + ' ms' +
            (exitInfo ? ' (the app exited early: code=' + exitInfo.code + ' signal=' + exitInfo.signal + ')' : '')
        );
    }

    const changed = differences(before, after);
    if (changed.length > 0) {
        failures.push('the real database was modified: ' + changed.join('; '));
    }

    const fixtureFp = fixtureDb ? fingerprint(fixtureDb) : { present: false };
    if (fixtureFp.present && before[DB_NAME].present && fixtureFp.sha256 === before[DB_NAME].sha256) {
        failures.push('the fixture krono.db is a byte-identical copy of the real one');
    }

    const result = {
        ok: failures.length === 0,
        failures,
        launch,
        fixtureDir,
        fixtureDb,
        fixtureRelative: fixtureDb ? path.relative(fixtureDir, fixtureDb) : null,
        realDir,
        before,
        after
    };

    if (!keep) fs.rmSync(fixtureRoot, { recursive: true, force: true });

    if (result.ok) {
        log(
            SCRIPT_NAME + ': OK - the fixture directory received a krono.db (' + fixtureFp.size +
            ' bytes at ./' + result.fixtureRelative.split(path.sep).join('/') + ') and the real ' +
            'database was untouched (' + describe(after[DB_NAME]) + ').'
        );
    }
    return result;
}

/*
 * The report every caller prints when the probe fails. It names assumption A1 explicitly, because
 * that phrase is what the plan's verification looks for and what tells a future reader the failure
 * is about redirection rather than about a missing file somewhere.
 */
export function failureReport(result) {
    const lines = [
        SCRIPT_NAME + ': REFUSING TO PROCEED - assumption A1 (--user-data-dir redirects ' +
        'app.getPath(\'userData\')) does NOT hold for this launch path.',
        'No baseline capture may run: it would render the owner\'s real client names and work',
        'notes into screenshots that are committed to a public repository (D-03).'
    ];
    for (const failure of result.failures) lines.push('  - ' + failure);
    return lines.join('\n');
}

/* ---------------------------------------------------------------------------------------- */
/* CLI                                                                                        */
/* ---------------------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const argv = process.argv.slice(2);
    const exeArg = argv.find((a) => a.startsWith('--exe='));
    if (exeArg) process.env.WFT_V121_EXE = exeArg.slice('--exe='.length);
    let result;
    try {
        result = await probeUserDataRedirection({ keep: argv.includes('--keep') });
    } catch (error) {
        console.error(SCRIPT_NAME + ': ' + error.message);
        process.exit(1);
    }
    if (!result.ok) {
        console.error(failureReport(result));
        process.exit(1);
    }
    process.exit(0);
}

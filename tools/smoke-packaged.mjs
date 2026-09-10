#!/usr/bin/env node
/*
 * BUILD-05 / BUILD-06 (D-13, D-14) - launch the PACKAGED, unpacked build and prove it opens a
 * SQLite database through the application's own path.
 *
 * A probe that merely require()s better-sqlite3 proves the driver loads. It does not prove that
 * the application's own resolution survives packaging: __dirname inside app.asar, the
 * app.asar.unpacked rewrite for the native addon, the renderer and preload paths, and the lazy
 * connection are all properties of the app's path, and each one works unpackaged and can break
 * packaged. So the packaged binary does the work itself - src/main/index.ts's --smoke branch opens
 * the database through src/lib/db/client.ts, writes a row, reads it back, loads its own renderer
 * through its own preload - and this script launches it and checks what it reports.
 *
 * It also checks the one number this milestone cannot afford to get wrong: the application name
 * the packaged app reports, from which Electron resolves userData. join(appData, name) must equal
 * the directory every installed v1.2.1 keeps krono.db in, byte for byte.
 *
 * What it never does: write to, read from, or delete anything under the real userData directory.
 * The app is launched with --user-data-dir pointing at a fresh mkdtemp directory, the database
 * path is injected through WORKFLOW_SMOKE_DB and points inside that directory, and the app itself
 * refuses to open a file that already exists.
 *
 * The child environment comes from tools/baseline/probe-userdata.mjs's childEnvironment(), which
 * strips ELECTRON_RUN_AS_NODE and NODE_OPTIONS. With ELECTRON_RUN_AS_NODE=1 inherited - and it
 * does leak into agent and tool sessions - the binary boots as plain Node, prints "bad option"
 * and exits 9, which looks exactly like a packaging failure. That lesson is reused, not relearned.
 *
 * The pure pieces are exported, as the probe's are, so a later plan can test them without a
 * packaged binary present.
 *
 * Usage:
 *   node tools/smoke-packaged.mjs              launch, report, exit 0 or 1
 *   node tools/smoke-packaged.mjs --keep       leave the fixture directory on disk
 *   node tools/smoke-packaged.mjs --dist=PATH  look for the unpacked build under PATH (default dist/)
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------------------------------- */
/* Pure pieces                                                                              */
/* ---------------------------------------------------------------------------------------- */

/*
 * Where electron-builder --dir puts the executable for a platform and architecture. x64 builds
 * land in the unsuffixed directory; every other architecture carries its name.
 */
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

/*
 * The production userData directory - the one that must NOT be touched, and that the packaged
 * app's reported name must resolve to. On Windows this is realUserDataDir() from the Phase 1 probe,
 * the directory every installed v1.2.1 uses. That helper is Windows-shaped (it reads %APPDATA%), so
 * macOS resolves Electron's own appData location instead.
 */
export function expectedProductionUserDataDir(platform = process.platform, home = os.homedir()) {
    if (platform === 'win32') return realUserDataDir();
    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', EXPECTED_APP_NAME);
    throw new Error(SCRIPT_NAME + ': no production userData location is defined for ' + platform);
}

/** Whether `child` is `parent` or lies inside it. */
export function isWithin(parent, child) {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/*
 * Two spellings of one directory. path.resolve first; realpath as a fallback, because Windows can
 * hand out an 8.3 short name for the temp directory and macOS puts /var behind a symlink.
 */
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

/*
 * Every assertion, as { label, pass, detail }. Pure: the caller supplies what was observed.
 *
 *   exit          { code, signal, timedOut }
 *   report        parseSmokeReport(stdout)
 *   childEnv      the environment object the child was spawned with
 *   fixtureDir    the --user-data-dir that was passed
 *   fixtureDb     the WORKFLOW_SMOKE_DB that was passed
 *   fixtureDbSize the database file's size after the run (0 if absent)
 *   productionDir expectedProductionUserDataDir()
 */
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

    return checks;
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

/* ---------------------------------------------------------------------------------------- */
/* The smoke launch                                                                           */
/* ---------------------------------------------------------------------------------------- */

export async function runPackagedSmoke(options = {}) {
    const log = options.quiet ? () => {} : (...parts) => console.log(...parts);
    const distDir = path.resolve(options.distDir ?? path.join(repoRoot, 'dist'));
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const binary = unpackedBinaryPath(distDir, process.platform, process.arch);
    if (!fs.existsSync(binary)) {
        return {
            ok: false,
            checks: [{
                label: 'an unpacked build exists',
                pass: false,
                detail: binary + ' is missing - run npm run build:unpack first'
            }]
        };
    }

    const productionDir = expectedProductionUserDataDir();
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-smoke-'));
    const fixtureDir = path.join(fixtureRoot, 'ud');
    fs.mkdirSync(fixtureDir);
    const fixtureDb = path.join(fixtureDir, SMOKE_DB_NAME);

    if (isWithin(productionDir, fixtureDir)) {
        // Only possible if the temp directory itself sits inside the real userData directory.
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        throw new Error(SCRIPT_NAME + ': the fixture directory ' + fixtureDir +
            ' is inside the real userData directory ' + productionDir + '; refusing to launch');
    }

    const { env, removed } = childEnvironment();
    const childEnv = { ...env, [SMOKE_DB_ENV]: fixtureDb };

    log(SCRIPT_NAME + ': launching ' + binary);
    log(SCRIPT_NAME + ':   --user-data-dir=' + fixtureDir);
    log(SCRIPT_NAME + ':   ' + SMOKE_DB_ENV + '=' + fixtureDb);
    if (removed.length > 0) log(SCRIPT_NAME + ': scrubbed from the child environment -> ' + removed.join(', '));

    let stdout = '';
    let stderr = '';
    const exit = await new Promise((resolve) => {
        let timedOut = false;
        const child = spawn(binary, ['--smoke', '--user-data-dir=' + fixtureDir], {
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

    const fixtureDbSize = fs.existsSync(fixtureDb) ? fs.statSync(fixtureDb).size : 0;
    const report = parseSmokeReport(stdout);
    const checks = evaluateSmoke({ exit, report, childEnv, fixtureDir, fixtureDb, fixtureDbSize, productionDir });
    if (exit.error) checks.push({ label: 'the binary could be spawned', pass: false, detail: exit.error });

    const result = { ok: checks.every((c) => c.pass), checks, stdout, stderr, fixtureDir, binary };

    if (options.keep) {
        log(SCRIPT_NAME + ': fixture kept at ' + fixtureRoot);
    } else {
        try {
            // Chromium helper processes can hold a file open for a moment after the main process exits.
            fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (error) {
            log(SCRIPT_NAME + ': could not remove the fixture directory ' + fixtureRoot + ': ' + error.message);
        }
    }
    return result;
}

/* ---------------------------------------------------------------------------------------- */
/* CLI                                                                                        */
/* ---------------------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const argv = process.argv.slice(2);
    const distArg = argv.find((a) => a.startsWith('--dist='));
    let result;
    try {
        result = await runPackagedSmoke({
            keep: argv.includes('--keep'),
            distDir: distArg ? distArg.slice('--dist='.length) : undefined
        });
    } catch (error) {
        console.error(SCRIPT_NAME + ': ' + error.message);
        process.exit(1);
    }
    for (const c of result.checks) {
        console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.label + ' - ' + c.detail);
    }
    if (!result.ok) {
        console.error(SCRIPT_NAME + ': the packaged smoke launch FAILED.');
        if (result.stdout) console.error('--- app stdout ---\n' + result.stdout.trimEnd());
        if (result.stderr) console.error('--- app stderr ---\n' + result.stderr.trimEnd());
        process.exit(1);
    }
    console.log('SMOKE_PACKAGED_OK');
    process.exit(0);
}

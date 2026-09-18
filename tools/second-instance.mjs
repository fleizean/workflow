#!/usr/bin/env node
/*
 * IPC-07, the item the Phase 5 verifier refused to certify: launching the packaged app a second time from one
 * profile focuses the window that is already there instead of opening a second one on the same SQLite file.
 *
 *   npm run instance:check          build:unpack first - this launches the packaged build twice
 *
 * WHY IT WAS OPEN. requestSingleInstanceLock() is a cross-PROCESS transition. tests/db-startup.test.ts asserts by
 * AST that the second-instance handler calls surfaceMainWindow, and the packaged smoke proves one tray icon within
 * ONE process - neither of which is the claim. Two processes on one krono.db is how v1.2.1 corrupts it, so the
 * claim has to be made with two real processes.
 *
 * WHAT IS DRIVEN, in order:
 *   1. the packaged app is launched over a mkdtemp profile and its window is hidden - the state a user is in when
 *      they click the shortcut again, and the state in which "focuses the existing window" is observable;
 *   2. the same binary is launched again, with the same --user-data-dir, as an ordinary child process;
 *   3. the second is required to EXIT, by itself, quickly, and to have opened no window;
 *   4. the first is required to still be alive, to still have exactly one main window, and to have SHOWN it -
 *      which is what surfaceMainWindow does and is the difference between focusing and ignoring;
 *   5. the first is required to still answer through its own IPC bridge afterwards, which is the database half:
 *      a second writer would have had to take the file from it.
 *
 * SAFETY. A mkdtemp profile; no real krono.db is opened.
 */

/* global window */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

import { appWindow } from './baseline/capture-v2.mjs';
import { childEnvironment } from './baseline/probe-userdata.mjs';
import { seedDatabase } from './baseline/seed-baseline-db.mjs';
import { DATABASE_FILE, unpackedBinaryPath } from './smoke-packaged.mjs';

const SCRIPT_NAME = 'tools/second-instance.mjs';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** How long the second launch may take to discover it is not wanted. It quits at the lock, before whenReady. */
export const SECOND_EXIT_TIMEOUT_MS = 30_000;
/** Time for the surfaced window to come back before it is read. */
const SURFACE_SETTLE_MS = 1_500;

export function judgeSecondInstance(observed) {
    const checks = [];
    const check = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail: String(detail) });

    check('the first launch opened exactly one window, and it was hidden before the second',
        observed.first.windowsBefore === 1 && observed.first.visibleBefore === false,
        'windows=' + String(observed.first.windowsBefore) + ' visible=' + String(observed.first.visibleBefore));

    check('the second launch exited by itself',
        observed.second.exited && !observed.second.timedOut,
        'code=' + String(observed.second.code) + ' signal=' + String(observed.second.signal) +
            (observed.second.timedOut ? ' (still running at the deadline)' : '') +
            ' after ' + String(observed.second.ms) + 'ms');
    check('the second launch exited cleanly, not by crashing',
        observed.second.code === 0, 'code=' + String(observed.second.code));
    check('the second launch said nothing on stderr',
        observed.second.stderr.trim() === '', JSON.stringify(observed.second.stderr.slice(0, 200)));

    check('the first process is still alive',
        observed.first.alive, observed.first.alive ? 'alive' : 'gone');
    check('there is still exactly one main window, not a second one on the same database',
        observed.first.windowsAfter === 1, 'windows=' + String(observed.first.windowsAfter));
    check('the existing window was surfaced rather than ignored',
        observed.first.visibleAfter === true,
        'visible before=' + String(observed.first.visibleBefore) + ' after=' + String(observed.first.visibleAfter));

    check('the first process still answers from its own database, so nothing took the file from it',
        observed.first.companiesAfter > 0,
        'companies:list returned ' + String(observed.first.companiesAfter) + ' row(s)');
    check('the second launch left no second write-ahead log beside the database',
        observed.walFiles.length <= 1, observed.walFiles.join(', ') || 'none');

    return checks;
}

/** The second process, launched the way a user's shortcut would launch it, and watched until it stops. */
function launchSecond(binary, userDataDir, env) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(binary, ['--no-sandbox', '--user-data-dir=' + userDataDir], {
            env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });

        const timer = setTimeout(() => {
            // It never quit: that IS the failure, so it is recorded and then killed rather than waited on for ever.
            try {
                if (process.platform === 'win32') {
                    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                } else {
                    child.kill('SIGKILL');
                }
            } catch { /* already gone */ }
            resolve({ exited: false, timedOut: true, code: null, signal: null, ms: Date.now() - started, stdout, stderr });
        }, SECOND_EXIT_TIMEOUT_MS);
        timer.unref();

        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ exited: true, timedOut: false, code, signal, ms: Date.now() - started, stdout, stderr });
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({
                exited: false, timedOut: false, code: null, signal: null, ms: Date.now() - started,
                stdout, stderr: stderr + String(error)
            });
        });
    });
}

export async function runSecondInstanceCheck(options = {}) {
    const log = options.quiet ? () => {} : (...parts) => { console.log(...parts); };
    const distDir = path.resolve(options.distDir ?? path.join(repoRoot, 'dist'));
    const binary = unpackedBinaryPath(distDir, process.platform, process.arch);
    if (!fs.existsSync(binary)) {
        throw new Error('no unpacked build at ' + binary + ' - run `npm run build:unpack` first');
    }

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-instance-'));
    const fixtureDir = path.join(fixtureRoot, 'ud');
    seedDatabase(fixtureDir);

    const { env } = childEnvironment();
    let app = null;
    let observed = null;

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

        /*
         * Hidden, the way the close button leaves it. A window that was already visible could not distinguish
         * "the second launch surfaced it" from "it was never hidden".
         */
        const before = await app.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            windows[0]?.hide();
            return { windows: windows.length, visible: windows[0]?.isVisible() ?? false };
        });
        log(SCRIPT_NAME + ': the first launch is up with ' + before.windows + ' window(s), now hidden');

        const second = await launchSecond(binary, fixtureDir, env);
        log(SCRIPT_NAME + ': the second launch ' +
            (second.exited ? 'exited ' + String(second.code) : 'did NOT exit') + ' after ' + second.ms + 'ms');

        await new Promise((resolve) => { setTimeout(resolve, SURFACE_SETTLE_MS); });

        const after = await app.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            return { windows: windows.length, visible: windows[0]?.isVisible() ?? false };
        });
        const companies = await page.evaluate(async () => {
            const answer = await window.api['companies:list']();
            return answer?.ok === true ? answer.data.length : -1;
        });

        const walFiles = fs.readdirSync(fixtureDir).filter((name) => name.startsWith(DATABASE_FILE + '-wal'));

        observed = {
            first: {
                alive: app.process().exitCode === null,
                windowsBefore: before.windows,
                visibleBefore: before.visible,
                windowsAfter: after.windows,
                visibleAfter: after.visible,
                companiesAfter: companies
            },
            second,
            walFiles
        };
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
        try {
            fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        } catch { /* harmless */ }
    }

    return { observed, checks: judgeSecondInstance(observed) };
}

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    let result;
    try {
        result = await runSecondInstanceCheck();
    } catch (error) {
        console.error(SCRIPT_NAME + ': ' + (error.stack ?? error.message));
        console.error(SCRIPT_NAME + ': run `npm run build:unpack` first; this gate launches the packaged app twice.');
        process.exit(1);
    }

    for (const check of result.checks) {
        console.log((check.pass ? 'PASS  ' : 'FAIL  ') + check.label + ' - ' + check.detail);
    }
    const failed = result.checks.filter((check) => !check.pass);
    console.log(SCRIPT_NAME + ': ' + (result.checks.length - failed.length) + '/' + result.checks.length +
        ' checks passed');
    if (failed.length > 0) {
        console.error(SCRIPT_NAME + ': a second launch is not being sent back to the first (IPC-07).');
        process.exit(1);
    }
    console.log('SECOND_INSTANCE_OK');
    process.exit(0);
}

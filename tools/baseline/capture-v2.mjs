#!/usr/bin/env node
/*
 * Photograph the v2 SPA the way tools/baseline/capture.mjs photographed v1.2.1, so criterion 2's "diffing computed
 * styles against the Phase 1 baselines" is a computation rather than a look.
 *
 * Same property set, same reader function, same window sizes, timezone, locale, colour scheme, device scale factor
 * and LCD-text setting - imported from capture.mjs rather than copied, because a second copy of the measurement is
 * a second thing that can drift. What differs is unavoidable and is the point: v1.2.1 was four HTML documents
 * under Electron 28 with the Tailwind Play CDN, and this is one document under Electron 44 with Tailwind compiled
 * at build time.
 *
 *   node tools/baseline/capture-v2.mjs --out=DIR   4 routes x 5 sizes -> DIR/computed, DIR/pixels
 *   node tools/baseline/capture-v2.mjs --smoke     1 route x 1 size into a temporary directory
 *
 * The fixture is seed-baseline-db.mjs's, unchanged: the v1.2.1-shaped krono.db the baselines were taken over,
 * which this build migrates on open. A different fixture would diff the content as well as the styling.
 */

/* global window, document, getComputedStyle */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

import { COMPUTED_PROPS, SIZES, readComputedStyles } from './capture.mjs';
import { childEnvironment } from './probe-userdata.mjs';
import { seedDatabase } from './seed-baseline-db.mjs';
import { unpackedBinaryPath } from '../smoke-packaged.mjs';

const SCRIPT_NAME = 'tools/baseline/capture-v2.mjs';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/*
 * The palette's background-dark, #101c22 - the same settled value capture.mjs waits on, read off a
 * different element. v1.2.1 carried the palette classes on <body>; AppShell carries them, and
 * src/renderer/index.html's <body> is deliberately bare, so body here computes to transparent. That
 * difference is a finding in its own right and is recorded in VISUAL-PARITY-DIFF.md; waiting on body
 * would simply hang.
 */
const SETTLED_BACKGROUND = 'rgb(16, 28, 34)';
const SETTLED_ELEMENT = '#app-shell';

/*
 * Which v2 route answers for which v1.2.1 page. `page` is the baseline artifact's stem, so a record
 * written here lands beside the one it is compared with and the filenames carry the pairing.
 */
export const ROUTES = [
    { page: 'index', hash: '#/', heading: 'Work Timer' },
    { page: 'companies', hash: '#/companies', heading: 'Companies' },
    { page: 'work-history', hash: '#/history', heading: 'Work History' },
    { page: 'settings', hash: '#/settings', heading: 'Settings' }
];

export { COMPUTED_PROPS, SIZES };

/*
 * firstWindow() is the WRONG window here. D-33 opens a hidden renderer at out/renderer/legacy-storage.html
 * to read v1.2.1's localStorage before the app window exists, and it closes itself the moment it has
 * answered - so a capture that grabbed the first window got a page that was already gone by the first
 * evaluate, reported as "Target page, context or browser has been closed".
 */
const APP_DOCUMENT = 'out/renderer/index.html';

export async function appWindow(app, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    const isApp = (candidate) => candidate.url().endsWith(APP_DOCUMENT);
    while (Date.now() < deadline) {
        const found = app.windows().find(isApp);
        if (found) return found;
        await app.waitForEvent('window', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => null);
    }
    throw new Error('no window at ' + APP_DOCUMENT + ' within ' + timeoutMs + 'ms');
}

async function captureRoute(page, win, route, sizes, out, log) {
    await page.evaluate((hash) => { window.location.hash = hash; }, route.hash);
    await page.waitForFunction(
        (expected) => document.querySelector('#root h1')?.textContent?.trim() === expected,
        route.heading,
        { timeout: 30000 }
    );
    await page.waitForFunction(
        ([selector, expected]) => {
            const shell = document.querySelector(selector);
            return shell !== null && getComputedStyle(shell).backgroundColor === expected;
        },
        [SETTLED_ELEMENT, SETTLED_BACKGROUND],
        { timeout: 30000 }
    );
    await page.evaluate(() => document.fonts.ready);

    const written = [];
    for (const [width, height] of sizes) {
        await win.evaluate(
            (browserWindow, size) => browserWindow.setContentSize(size[0], size[1]),
            [width, height]
        );
        await page.waitForFunction((w) => window.innerWidth === w, width, { timeout: 15000 });
        /* Let the resize-driven layout and the fire canvas's ResizeObserver settle. */
        await page.waitForTimeout(150);

        const stem = route.page + '@' + width + 'x' + height;
        const pngPath = path.join(out, 'pixels', stem + '.png');
        const jsonPath = path.join(out, 'computed', stem + '.json');
        fs.mkdirSync(path.dirname(pngPath), { recursive: true });
        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });

        await page.screenshot({
            path: pngPath,
            animations: 'disabled',
            caret: 'hide',
            /* The streak card's fire canvas is the one non-deterministic region, as in v1.2.1. */
            mask: [page.locator('canvas')],
            fullPage: false
        });

        const styles = await readComputedStyles(page);
        fs.writeFileSync(jsonPath, JSON.stringify(styles, null, 2) + '\n');

        written.push({ png: pngPath, json: jsonPath, elements: Object.keys(styles).length });
        log(SCRIPT_NAME + ':   ' + stem + ' -> ' + written.at(-1).elements + ' elements');
    }
    return written;
}

export async function runCaptureV2(options = {}) {
    const smoke = options.smoke ?? false;
    const log = options.quiet ? () => {} : (...parts) => console.log(...parts);
    const routes = smoke ? ROUTES.slice(0, 1) : ROUTES;
    const sizes = smoke ? [[1280, 800]] : SIZES;

    const distDir = path.resolve(options.distDir ?? path.join(repoRoot, 'dist'));
    const binary = unpackedBinaryPath(distDir, process.platform, process.arch);
    if (!fs.existsSync(binary)) {
        throw new Error('no unpacked build at ' + binary + ' - run `npm run build:unpack` first');
    }

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-capture-v2-'));
    const fixtureDir = path.join(fixtureRoot, 'ud');
    const seeded = seedDatabase(fixtureDir);
    log(SCRIPT_NAME + ': fixture seeded at ' + seeded.file + ' (today=' + seeded.dates.today + ')');

    const out = options.out ?? path.join(fixtureRoot, 'out');
    const remote = [];
    let app = null;
    const written = [];

    /*
     * ELECTRON_RUN_AS_NODE in the ambient environment boots the executable as plain Node, whose option
     * parser then rejects --no-sandbox and exits - which reads as "the app failed to launch" and not as
     * "the harness poisoned it". probe-userdata.mjs found this in Phase 1; the scrubbing is shared.
     */
    const { env, removed } = childEnvironment();
    if (removed.length > 0) log(SCRIPT_NAME + ': scrubbed from the child environment -> ' + removed.join(', '));

    try {
        app = await electron.launch({
            executablePath: binary,
            env,
            args: [
                '--no-sandbox',
                '--user-data-dir=' + fixtureDir,
                '--force-device-scale-factor=1',
                '--disable-lcd-text'
            ],
            timezoneId: 'Europe/Istanbul',
            locale: 'tr-TR',
            colorScheme: 'dark'
        });

        const page = await appWindow(app);
        const win = await app.browserWindow(page);

        /*
         * S3/S4: nothing remote may be reached. The CSP in index.html is what forbids it and Phase 10
         * criterion 7 is what proves it offline; this is a passive record of any attempt made while the
         * capture is driving, so a capture cannot quietly depend on a live third party the way v1.2.1's
         * would have without tools/baseline/vendor.
         */
        page.on('request', (request) => {
            if (/^https?:/.test(request.url())) remote.push(request.url());
        });

        await page.waitForLoadState('load');

        /*
         * Phase 11: the verdict must not depend on where the operator's mouse is.
         *
         * At 1920x1080 the window fills the screen, so the real pointer is inside it, Chromium applies :hover to
         * whatever it lands on, and the vocabulary diff reads that as a colour v1.2.1 never rendered. Reproduced
         * as `oklab(0.684327 -0.0772989 -0.129777 / 0.9)` on the Settings Save button - Tailwind's
         * hover:bg-primary/90, which normalises to #13a4ece6. Three consecutive runs each failed on a DIFFERENT
         * page and property, because the answer was the pointer.
         *
         * setIgnoreMouseEvents is the only version a resize cannot undo: moving or resizing a window under the
         * cursor makes Windows deliver a fresh WM_MOUSEMOVE, so a synthetic move is re-overwritten.
         */
        await win.evaluate((browserWindow) => { browserWindow.setIgnoreMouseEvents(true); });
        /* Clears any hover the window had already picked up between opening and the line above. */
        await page.mouse.move(-1, -1);

        for (const route of routes) {
            log(SCRIPT_NAME + ': ' + route.page + ' (' + route.hash + ')');
            written.push(...await captureRoute(page, win, route, sizes, out, log));
        }
    } finally {
        if (app) {
            const pid = app.process().pid;
            try {
                await Promise.race([
                    app.evaluate(({ app: electronApp }) => electronApp.exit(0)),
                    new Promise((resolve) => setTimeout(resolve, 10000))
                ]);
            } catch {
                /* already gone; the backstop below settles it either way */
            }
            try {
                if (process.platform === 'win32') {
                    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
                } else {
                    process.kill(pid, 'SIGKILL');
                }
            } catch {
                /* already exited - the expected path */
            }
        }
    }

    log(SCRIPT_NAME + ': wrote ' + written.length + ' PNG and ' + written.length + ' JSON under ' + out);
    return { out, written, remote, fixtureRoot };
}

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const argv = process.argv.slice(2);
    const smoke = argv.includes('--smoke');
    const outArg = argv.find((a) => a.startsWith('--out='));

    let result;
    try {
        result = await runCaptureV2({
            smoke,
            out: outArg ? path.resolve(outArg.slice('--out='.length)) : undefined
        });
    } catch (error) {
        console.error(SCRIPT_NAME + ': ' + (error.stack ?? error.message));
        process.exit(1);
    }

    if (result.written.length === 0) {
        console.error(SCRIPT_NAME + ': no artifact was written');
        process.exit(1);
    }
    if (result.remote.length > 0) {
        console.error(SCRIPT_NAME + ': the app attempted ' + result.remote.length + ' remote request(s):');
        for (const url of result.remote.slice(0, 5)) console.error(SCRIPT_NAME + ':   ' + url);
        process.exit(1);
    }

    if (!outArg) {
        try {
            fs.rmSync(result.fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        } catch (error) {
            console.warn(SCRIPT_NAME + ': could not remove ' + result.fixtureRoot + ' (' + error.code + '); harmless');
        }
    }
    console.log(SCRIPT_NAME + ': OK - ' + result.written.length + ' PNG + ' + result.written.length + ' JSON');
    process.exit(0);
}

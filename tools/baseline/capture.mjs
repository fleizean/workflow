#!/usr/bin/env node
/*
 * CUSTODY-10 / D-11 - photograph v1.2.1 deterministically, so that Phase 8 can prove the rewrite
 * changed nothing it was not supposed to change.
 *
 * WHY THIS EXISTS. Once src/pages/*.html are deleted there is no way to re-render v1.2.1. The
 * owner chose Tailwind v4 with a compatibility layer (G1) rather than pinning v3, so the
 * regressions this baseline has to catch are the silent ones: `rounded` becoming `rounded-sm`,
 * `shadow` becoming `shadow-sm`, `ring` becoming `ring-3`, `outline-none` becoming
 * `outline-hidden`, and changed default border, ring and placeholder colours. None of those is
 * visible to an eyeball comparison. All of them are obvious in a computed-style diff, which is why
 * this script emits JSON next to every PNG.
 *
 * THE ENTRY GATE. Before this script is structurally able to take a screenshot it runs
 * tools/baseline/probe-userdata.mjs and refuses to continue unless the fixture redirection has been
 * proven IN THIS RUN. A silent redirection failure would not produce an error - it would produce
 * beautiful screenshots of the owner's real client names, committed to a public repository, which
 * cannot be un-published (D-03). `--smoke --skip-probe` is asserted by the plan to exit non-zero:
 * a gate that cannot be observed to fail is decoration.
 *
 * Modes:
 *   node tools/baseline/capture.mjs                 4 pages x 5 sizes -> baselines/v1.2.1/
 *   node tools/baseline/capture.mjs --smoke         1 page x 1 size -> a temporary directory
 *   node tools/baseline/capture.mjs --skip-probe    MUST exit non-zero
 *   node tools/baseline/capture.mjs --out=DIR       override the output root
 *
 * Scope (D-11): playwright-core is used in this phase to capture and in Phase 8 to compare, and
 * nowhere else. It is pinned to exactly 1.63.0 because Playwright's Electron support is
 * experimental and sits outside its stability guarantees, so Phase 8 must compare against a capture
 * taken by the same driver.
 */

/*
 * The callbacks passed to page.evaluate / page.waitForFunction below are serialised and run inside
 * the RENDERER, not in this Node process, so they legitimately reference browser globals. Declared
 * inline rather than by adding globals.browser to the `**\/*.mjs` block in eslint.config.js: that
 * block covers every tooling script in the repository, and only this one file crosses into the
 * page. A file-scoped declaration keeps `no-undef` doing its job everywhere else.
 */
/* global window, document, getComputedStyle */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

import {
    childEnvironment,
    failureReport,
    probeUserDataRedirection,
    resolveLaunch
} from './probe-userdata.mjs';
import { readVendorIndex, resolveVendored, seedDatabase, verifyVendor } from './seed-baseline-db.mjs';

const SCRIPT_NAME = 'tools/baseline/capture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vendorDir = path.join(repoRoot, 'tools', 'baseline', 'vendor');

/* The five window sizes RESP-02 cares about, and the four pages v1.2.1 has. */
export const SIZES = [[380, 600], [430, 932], [768, 1024], [1280, 800], [1920, 1080]];
export const PAGES = ['index', 'companies', 'work-history', 'settings'];

/* The palette's background-dark, #101c22, as Chromium reports it. Waiting on this value rather than
 * on a load state is the whole trick: the Tailwind Play CDN is a JIT engine that generates CSS from
 * the live DOM through a MutationObserver, so `load` fires long before the page is styled. */
const SETTLED_BACKGROUND = 'rgb(16, 28, 34)';

const COMPUTED_PROPS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'color',
    'background-color', 'border', 'border-radius', 'box-shadow', 'font-family', 'font-size',
    'font-weight', 'line-height', 'letter-spacing', 'flex', 'grid-template-columns', 'gap',
    'opacity', 'overflow', 'outline', 'z-index', 'transform'
];

const VENDORED_HOSTS = ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

/* ---------------------------------------------------------------------------------------- */
/* Vendored assets                                                                            */
/* ---------------------------------------------------------------------------------------- */

/*
 * Verify once, at startup, then serve from memory. verifyVendor() checks every file on disk against
 * tools/baseline/vendor/index.json AND against the digest table in baselines/v1.2.1/MANIFEST.md, so
 * "verified against the manifest before use" is satisfied for the whole run by a single pass; the
 * alternative, re-hashing 1.8 MB on every request, would verify the same bytes dozens of times and
 * prove nothing extra.
 */
function loadVendorCache() {
    const verification = verifyVendor();
    if (!verification.ok) {
        throw new Error(
            `vendored assets failed verification:\n  - ${verification.failures.join('\n  - ')}`
        );
    }
    const index = readVendorIndex();
    const cache = new Map();
    for (const asset of index.assets) {
        const body = fs.readFileSync(path.join(vendorDir, asset.file));
        const digest = crypto.createHash('sha256').update(body).digest('hex');
        if (digest !== asset.sha256) throw new Error(`${asset.file} changed between verify and read`);
        cache.set(asset.file, { body, contentType: asset.contentType });
    }
    return { index, cache, count: verification.count };
}

/* ---------------------------------------------------------------------------------------- */
/* Capture                                                                                    */
/* ---------------------------------------------------------------------------------------- */

async function capturePage(page, win, name, sizes, out, log) {
    const pagePath = `src/pages/${name}.html`;
    await win.evaluate((browserWindow, target) => browserWindow.loadFile(target), pagePath);
    await page.waitForFunction(
        (file) => window.location.pathname.endsWith(file),
        `${name}.html`,
        { timeout: 30000 }
    );
    await page.waitForFunction(
        (expected) => getComputedStyle(document.body).backgroundColor === expected,
        SETTLED_BACKGROUND,
        { timeout: 30000 }
    );
    await page.evaluate(() => document.fonts.ready);

    const written = [];
    for (const [width, height] of sizes) {
        await win.evaluate(
            (browserWindow, size) => browserWindow.setContentSize(size[0], size[1]),
            [width, height]
        );
        /* main.js:31 makes the window frameless, so setSize and setContentSize differ. Assert the
         * renderer actually reached the requested width before capturing. */
        await page.waitForFunction((w) => window.innerWidth === w, width, { timeout: 15000 });

        const stem = `${name}@${width}x${height}`;
        const pngPath = path.join(out, 'pixels', `${stem}.png`);
        const jsonPath = path.join(out, 'computed', `${stem}.json`);
        fs.mkdirSync(path.dirname(pngPath), { recursive: true });
        fs.mkdirSync(path.dirname(jsonPath), { recursive: true });

        await page.screenshot({
            path: pngPath,
            animations: 'disabled',
            caret: 'hide',
            mask: [page.locator('#streakFireCanvas')],
            fullPage: false
        });

        const styles = await page.evaluate((props) => {
            const pathOf = (el) => {
                const parts = [];
                for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
                    const i = Array.prototype.indexOf.call(n.parentElement?.children ?? [], n);
                    parts.unshift(`${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}:nth-child(${i + 1})`);
                }
                return parts.join(' > ');
            };
            const result = {};
            for (const el of document.querySelectorAll('*')) {
                const cs = getComputedStyle(el);
                const record = {};
                for (const prop of props) record[prop] = cs.getPropertyValue(prop);
                result[pathOf(el)] = record;
            }
            return result;
        }, COMPUTED_PROPS);
        fs.writeFileSync(jsonPath, `${JSON.stringify(styles, null, 2)}\n`);

        written.push({ png: pngPath, json: jsonPath, elements: Object.keys(styles).length });
        log(`${SCRIPT_NAME}:   ${stem} -> ${written.at(-1).elements} elements`);
    }
    return written;
}

export async function runCapture(options = {}) {
    const smoke = options.smoke ?? false;
    const log = options.quiet ? () => {} : (...parts) => console.log(...parts);
    const pages = smoke ? ['index'] : PAGES;
    const sizes = smoke ? [[1280, 800]] : SIZES;

    const vendor = loadVendorCache();
    log(`${SCRIPT_NAME}: ${vendor.count} vendored assets verified against MANIFEST.md`);

    const launch = resolveLaunch();
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-capture-'));
    const fixtureDir = path.join(fixtureRoot, 'ud');
    const seeded = seedDatabase(fixtureDir);
    log(`${SCRIPT_NAME}: fixture seeded at ${seeded.file} (today=${seeded.dates.today})`);

    const out = options.out ?? (smoke
        ? path.join(fixtureRoot, 'out')
        : path.join(repoRoot, 'baselines', 'v1.2.1'));

    const { env } = childEnvironment();
    const blocked = [];
    const fulfilled = new Set();
    let app = null;
    const written = [];

    try {
        app = await electron.launch({
            executablePath: launch.executable,
            args: [
                ...launch.args,
                `--user-data-dir=${fixtureDir}`,
                /* Every flag below is a measured source of drift, not a precaution. */
                '--force-device-scale-factor=1',
                '--disable-lcd-text'
            ],
            env,
            timezoneId: 'Europe/Istanbul',
            locale: 'tr-TR',
            colorScheme: 'dark'
        });

        const context = app.context();

        /*
         * Two URL-PREDICATE routes rather than one '**\/*' glob, and the difference is not stylistic.
         * A catch-all also intercepts the file:// navigation that loads the application's own pages
         * out of app.asar, and route.continue() on a file:// request aborts it - the whole capture
         * dies with "(-3) loading file:///.../app.asar/src/pages/index.html", which reads like a
         * missing page rather than a routing bug. Predicates keep interception on http(s) only, so
         * the app's own navigation is never touched.
         *
         * The glob form would not have worked anyway: the Tailwind URL is
         * `https://cdn.tailwindcss.com?plugins=...`, with a query and no path.
         */
        const isVendoredHost = (url) => VENDORED_HOSTS.includes(url.hostname);
        const isOtherRemote = (url) => /^https?:$/.test(url.protocol) && !isVendoredHost(url);

        await context.route(isVendoredHost, async (route) => {
            const url = route.request().url();
            const asset = resolveVendored(url, vendor.index);
            if (!asset) {
                blocked.push(url);
                await route.abort('blockedbyclient');
                return;
            }
            const cached = vendor.cache.get(asset.file);
            fulfilled.add(asset.file);
            await route.fulfill({ body: cached.body, contentType: cached.contentType });
        });

        /* Fail loud, not silently online: an un-vendored remote request would put the baseline back
         * at the mercy of a live third party, which is the drift this whole directory exists to
         * remove. Blocked URLs are reported, and the run reports which hosts were actually served. */
        await context.route(isOtherRemote, async (route) => {
            blocked.push(route.request().url());
            await route.abort('blockedbyclient');
        });

        const page = await app.firstWindow();
        const win = await app.browserWindow(page);

        /*
         * Let the startup navigation finish before issuing one of our own. createWindow() calls
         * loadFile('src/pages/index.html') at app.whenReady(), and firstWindow() resolves as soon as
         * the BrowserWindow exists - not when it has loaded. Navigating on top of an in-flight load
         * cancels it, and Electron's loadFile promise rejects on the FIRST did-fail-load it sees,
         * which is the cancelled one: "(-3) loading file:///.../app.asar/src/pages/index.html". That
         * error names the file we asked for, so it reads like a missing page rather than a race.
         */
        await page.waitForLoadState('load');

        /* Any subresource fetched before the routes above were installed is now in the HTTP cache.
         * Clear it, or a re-navigation could be served the live CDN rather than the vendored copy
         * and the whole pinning exercise would be theatre. */
        await app.evaluate(({ session }) => session.defaultSession.clearCache());

        for (const name of pages) {
            log(`${SCRIPT_NAME}: ${name}`);
            written.push(...await capturePage(page, win, name, sizes, out, log));
        }
    } finally {
        if (app) {
            /* NOT app.close(): main.js:70-72 preventDefault()s the close event and hides to the
             * tray unless the tray Quit item set isQuiting, so a close request hangs with no
             * diagnostic (research pitfall 4). */
            const pid = app.process().pid;
            try {
                await Promise.race([
                    app.evaluate(({ app: electronApp }) => electronApp.exit(0)),
                    new Promise((resolve) => setTimeout(resolve, 10000))
                ]);
            } catch {
                /* the process may already be gone; the backstop below settles it either way */
            }
            try {
                if (process.platform === 'win32') {
                    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
                } else {
                    process.kill(pid, 'SIGKILL');
                }
            } catch {
                /* already exited - this is the expected path */
            }
        }
    }

    const missedHosts = VENDORED_HOSTS.filter(
        (host) => ![...fulfilled].some((file) => hostServes(host, file))
    );

    const result = { out, written, blocked, fulfilled: [...fulfilled], missedHosts, fixtureRoot };
    if (blocked.length > 0) {
        log(`${SCRIPT_NAME}: WARNING - ${blocked.length} un-vendored remote request(s) were blocked:`);
        for (const url of blocked.slice(0, 5)) log(`${SCRIPT_NAME}:   ${url}`);
    }
    log(`${SCRIPT_NAME}: wrote ${written.length} PNG and ${written.length} JSON under ${out}`);
    return result;
}

function hostServes(host, file) {
    if (host === 'cdn.tailwindcss.com') return file === 'tailwind.js';
    if (host === 'fonts.googleapis.com') return file.startsWith('fonts-css/');
    return file.startsWith('fonts/');
}

/* ---------------------------------------------------------------------------------------- */
/* CLI - the entry gate lives here and nowhere else                                           */
/* ---------------------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const argv = process.argv.slice(2);
    const smoke = argv.includes('--smoke');
    const outArg = argv.find((a) => a.startsWith('--out='));

    if (argv.includes('--skip-probe')) {
        console.error(
            `${SCRIPT_NAME}: REFUSING TO RUN - --skip-probe was passed.\n` +
            'The fixture-redirection probe is not optional. Without it, a silent --user-data-dir\n' +
            'failure produces screenshots of the owner\'s real client names and work notes, and\n' +
            'those screenshots are committed to a public repository (D-03). This flag exists only\n' +
            'so that the gate can be OBSERVED to fail; a gate that cannot fail is decoration.'
        );
        process.exit(3);
    }

    console.log(`${SCRIPT_NAME}: running the fixture-redirection probe before anything else`);
    let probe;
    try {
        probe = await probeUserDataRedirection();
    } catch (error) {
        console.error(`${SCRIPT_NAME}: ${error.message}`);
        process.exit(1);
    }
    if (!probe.ok) {
        console.error(failureReport(probe));
        process.exit(1);
    }

    let result;
    try {
        result = await runCapture({ smoke, out: outArg ? path.resolve(outArg.slice('--out='.length)) : undefined });
    } catch (error) {
        console.error(`${SCRIPT_NAME}: ${error.stack ?? error.message}`);
        process.exit(1);
    }

    if (result.written.length === 0) {
        console.error(`${SCRIPT_NAME}: no artifact was written`);
        process.exit(1);
    }
    if (result.missedHosts.length > 0) {
        console.error(
            `${SCRIPT_NAME}: no request was fulfilled from ${result.missedHosts.join(', ')} - ` +
            'the interception is not reaching the page'
        );
        process.exit(1);
    }
    /* The fixture database always goes; in --smoke without --out the artifacts live inside it and
     * go with it, because plan 01-06 - not this one - owns the real capture run.
     *
     * Retries and a swallowed error are not laziness. The Electron process was killed a moment ago
     * and Windows does not release its handles on the fixture database synchronously, so a plain
     * rmSync loses a race and throws EPERM AFTER a completely successful capture - turning a green
     * run red for a leftover temporary directory the OS will clean up anyway. */
    try {
        fs.rmSync(result.fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (error) {
        console.warn(`${SCRIPT_NAME}: could not remove ${result.fixtureRoot} (${error.code}); harmless`);
    }
    if (smoke) console.log(`${SCRIPT_NAME}: SMOKE_OK - ${result.written.length} PNG + ${result.written.length} JSON written, temporary output removed`);
    process.exit(0);
}

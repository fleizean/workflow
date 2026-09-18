#!/usr/bin/env node
/*
 * Phase 10 criterion 7, on every route rather than on the one the smoke boots into.
 *
 *   npm run offline:check          build:unpack first - this drives the packaged build
 *   npm run offline:check -- --write   rewrite the committed report after a deliberate change
 *
 * Phase 7 proved offline rendering for the boot route, which is where the packaged smoke stops. The criterion is
 * about EVERY route, and about two things the smoke does not look for: that the console reports ZERO CSP
 * violations - captured, not assumed absent - and that the icons are glyphs everywhere and not just on Home.
 *
 * WHAT OFFLINE MEANS HERE. Chromium's own network stack is put offline before the document is reloaded, and every
 * http/https/ws request is cancelled and recorded by a webRequest filter, so a resource that WAS fetched is a
 * failure with a URL attached rather than a silent success against a warm cache.
 *
 * WHAT IS CHECKED, PER ROUTE:
 *   - the route renders: its heading is on screen and the shell has its settled background;
 *   - Inter: document.fonts.check resolves the family, and the text on screen computes to it;
 *   - icons: EVERY .material-symbols-outlined element measures at glyph width, not at the width its name would
 *     occupy as literal text - SPA-08's probe, applied to all of them instead of one;
 *   - filled variants: the elements that ask for the FILL axis get it, read back off the live element;
 *   - the notification sound: the bundled file resolves to a file: URL inside the app and decodes to a duration;
 *   - zero CSP violations, captured from the securitypolicyviolation event AND from the console;
 *   - zero remote requests.
 *
 * WHAT IT DOES NOT PROVE. That the glyphs are the RIGHT pictures. Nothing here rasterises; width and the FILL axis
 * are what distinguish a glyph from the word "chevron_left", which is the failure mode S4 actually produces.
 */

/* global window, document, getComputedStyle, Audio */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

import { ROUTES, appWindow } from './baseline/capture-v2.mjs';
import { childEnvironment } from './baseline/probe-userdata.mjs';
import { seedDatabase } from './baseline/seed-baseline-db.mjs';
import { unpackedBinaryPath } from './smoke-packaged.mjs';

const SCRIPT_NAME = 'tools/offline-routes.mjs';
const NEWLINE = String.fromCharCode(10);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(repoRoot, 'baselines', 'v2', 'OFFLINE-ROUTES.md');

/*
 * A Material Symbols ligature is about one em wide. 1.6 leaves room for the widest of them and for hinting; the
 * same name as text is measured in the page and must be at least MIN_NAME_EMS, or the bound separates nothing.
 * src/main/config.ts states the same distinction in pixels at one fixed size (SMOKE_ICON_MAX_WIDTH_PX = 32 at a
 * 24px font, which is 1.33em); this is that rule generalised to every size the app draws an icon at.
 */
export const MAX_GLYPH_EMS = 1.6;
export const MIN_NAME_EMS = 3;
/** The two families that must come from inside the bundle (S4), spelled as their @font-face declares them. */
export const BUNDLED_FONTS = ['Inter Variable', 'Material Symbols Outlined'];
/** How Chromium spells a resolved FILL axis. */
export const FILL_ON = '"FILL" 1';
/** The window this runs at. Wide enough that nothing is hidden by layout, so every icon on the route is measured. */
const SIZE = [430, 932];

/* ---------------------------------------------------------------------------------------- */
/* The in-page probe                                                                          */
/* ---------------------------------------------------------------------------------------- */

function probeInPage(limits) {
    const fonts = {};
    for (const family of limits.fonts) {
        fonts[family] = document.fonts.check('16px "' + family + '"');
    }

    /*
     * Every icon on the route. An unresolved Material Symbols font renders the ligature NAME as text, which is
     * several times wider than the glyph - the whole shape of the S4 failure, and measurable.
     *
     * The GLYPH is measured, not the element: half these spans are `block` inside a full-width navigation cell, so
     * their border box says nothing about what was drawn. The bound is in ems, because the same ligature is drawn
     * at 12px in a list row and at 48px on the play button.
     */
    const icons = [];
    for (const element of document.querySelectorAll('.material-symbols-outlined')) {
        const style = getComputedStyle(element);
        const fontSize = Number.parseFloat(style.fontSize) || 16;
        const range = document.createRange();
        range.selectNodeContents(element);
        const glyph = range.getBoundingClientRect().width;
        range.detach();
        if (glyph === 0) continue;
        icons.push({
            name: (element.textContent ?? '').trim(),
            width: glyph,
            fontSize,
            ems: glyph / fontSize,
            fontFamily: style.fontFamily,
            variation: style.fontVariationSettings
        });
    }

    /*
     * The control, measured in this very document: the longest icon name on the route, drawn as ordinary text at
     * the same size in the page's own font. If that is not several times wider than the glyphs above, the bound
     * below separates nothing and the whole check is decoration.
     */
    const longest = icons.reduce((worst, icon) => (icon.name.length > worst.length ? icon.name : worst), '');
    const probe = document.createElement('span');
    probe.textContent = longest;
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;font-size:16px;white-space:nowrap';
    document.body.appendChild(probe);
    const nameAsTextEms = probe.getBoundingClientRect().width / 16;
    probe.remove();

    /* The text of the page, and what it is actually drawn in. */
    const bodyFont = getComputedStyle(document.body).fontFamily;
    const heading = document.querySelector('#root h1');
    const headingFont = heading === null ? '' : getComputedStyle(heading).fontFamily;

    return {
        fonts,
        icons,
        longestName: longest,
        nameAsTextEms,
        bodyFont,
        headingFont,
        shellBackground: (() => {
            const shell = document.getElementById('app-shell');
            return shell === null ? '' : getComputedStyle(shell).backgroundColor;
        })(),
        violations: Array.isArray(window.__cspViolations) ? [...window.__cspViolations] : []
    };
}

/*
 * The bundled sound, decoded in the page with the network off.
 *
 * SoundProvider constructs its Audio element lazily, so there is no resource entry to read the URL out of and no
 * element on the page to inspect. The asset NAME is supplied by the caller, read from the emitted build, and
 * resolved here against the document's own base URL. tests/renderer-build-output.test.ts holds the emitted asset
 * and the renderer's reference to it equal; what this adds is that the file decodes, from inside the archive,
 * offline.
 */
function probeSoundInPage(assetName) {
    return new Promise((resolve) => {
        const source = new URL('assets/' + assetName, document.baseURI).href;
        const audio = new Audio(source);
        audio.preload = 'auto';
        const done = (error) => resolve({
            src: audio.currentSrc || audio.src,
            duration: Number.isFinite(audio.duration) ? audio.duration : 0,
            error
        });
        audio.addEventListener('loadedmetadata', () => { done(''); }, { once: true });
        audio.addEventListener('error', () => { done('MediaError ' + String(audio.error?.code ?? 0)); }, { once: true });
        setTimeout(() => { done('the sound did not load within 5s'); }, 5000);
        audio.load();
    });
}

/* ---------------------------------------------------------------------------------------- */
/* Verdicts                                                                                   */
/* ---------------------------------------------------------------------------------------- */

export function judgeRouteOffline(route, probe, limits = { maxEms: MAX_GLYPH_EMS, minNameEms: MIN_NAME_EMS }) {
    const checks = [];
    const check = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail: String(detail) });
    const at = (text) => route + ': ' + text;

    check(at('the route rendered with the palette applied'), probe.shellBackground === 'rgb(16, 28, 34)',
        'shell background ' + probe.shellBackground);

    for (const family of BUNDLED_FONTS) {
        check(at(family + ' resolved from inside the bundle'), probe.fonts[family] === true,
            'document.fonts.check -> ' + String(probe.fonts[family]));
    }
    check(at('the text on screen is drawn in Inter'), /Inter Variable/.test(probe.headingFont || probe.bodyFont),
        'heading ' + JSON.stringify(probe.headingFont) + ' body ' + JSON.stringify(probe.bodyFont));

    check(at('the route has icons to judge'), probe.icons.length > 0, String(probe.icons.length) + ' icon(s)');

    /*
     * A Material Symbols ligature is about one em wide whatever size it is drawn at; the same name as literal text
     * is many ems. The bound is in ems for that reason - this app draws the same icon at 12px in a list row and at
     * 48px on the play button, and a pixel bound would either pass everything or fail the big one.
     */
    const wide = probe.icons.filter((icon) => icon.ems > limits.maxEms);
    check(at('every icon measures as a glyph, not as its own name in text'), wide.length === 0,
        wide.length === 0
            ? String(probe.icons.length) + ' icon(s), widest ' +
              String(Math.max(0, ...probe.icons.map((icon) => icon.ems)).toFixed(2)) + 'em'
            : wide.slice(0, 5).map((icon) => icon.name + '=' + icon.ems.toFixed(2) + 'em').join(', '));
    check(at('the bound separates a glyph from a name, in this document'),
        probe.nameAsTextEms >= limits.minNameEms,
        JSON.stringify(probe.longestName) + ' as text is ' + probe.nameAsTextEms.toFixed(2) + 'em, glyphs are at ' +
            'most ' + String(limits.maxEms) + 'em');

    check(at('every icon is drawn in the Material Symbols family'),
        probe.icons.every((icon) => /Material Symbols Outlined/.test(icon.fontFamily)),
        probe.icons.map((icon) => icon.fontFamily).find((family) => !/Material Symbols Outlined/.test(family)) ??
            'all ' + String(probe.icons.length));

    const filled = probe.icons.filter((icon) => icon.variation.includes(FILL_ON));
    check(at('the icons that ask to be filled are filled'), filled.length > 0,
        String(filled.length) + ' of ' + String(probe.icons.length) + ' report ' + FILL_ON);

    check(at('the console reported no CSP violation'), probe.violations.length === 0,
        probe.violations.slice(0, 5).join(' | ') || 'none');

    return checks;
}

export function judgeSound(probe) {
    return [
        {
            label: 'the notification sound resolves to a file inside the app',
            pass: probe.src.startsWith('file:') && probe.src.endsWith('.mp3'),
            detail: probe.src === '' ? (probe.error || 'no source') : probe.src
        },
        {
            label: 'the notification sound decodes with the network off',
            pass: probe.error === '' && probe.duration > 0,
            detail: 'duration=' + String(probe.duration) + (probe.error === '' ? '' : ' error=' + probe.error)
        }
    ];
}

/* ---------------------------------------------------------------------------------------- */
/* Driving                                                                                    */
/* ---------------------------------------------------------------------------------------- */

/*
 * The fingerprinted name Vite gave src/assets/notification.mp3 in THIS build. Read from out/renderer/assets rather
 * than hard-coded, because the hash changes whenever the file does; the packaged archive carries the same layout.
 */
function emittedSoundName() {
    const dir = path.join(repoRoot, 'out', 'renderer', 'assets');
    const found = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.mp3')) : [];
    if (found.length !== 1) {
        throw new Error('expected exactly one emitted .mp3 under out/renderer/assets, found ' + found.length);
    }
    return found[0];
}

export async function runOfflineRoutes(options = {}) {
    const log = options.quiet ? () => {} : (...parts) => { console.log(...parts); };
    const distDir = path.resolve(options.distDir ?? path.join(repoRoot, 'dist'));
    const binary = unpackedBinaryPath(distDir, process.platform, process.arch);
    if (!fs.existsSync(binary)) {
        throw new Error('no unpacked build at ' + binary + ' - run `npm run build:unpack` first');
    }

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-offline-'));
    const fixtureDir = path.join(fixtureRoot, 'ud');
    seedDatabase(fixtureDir);

    const { env } = childEnvironment();
    const routes = [];
    const consoleErrors = [];
    let blocked = [];
    let sound = null;
    let app = null;

    try {
        app = await electron.launch({
            executablePath: binary,
            env,
            args: ['--no-sandbox', '--user-data-dir=' + fixtureDir, '--force-device-scale-factor=1', '--disable-lcd-text'],
            timezoneId: 'Europe/Istanbul',
            locale: 'tr-TR',
            colorScheme: 'dark'
        });

        const page = await appWindow(app);
        const win = await app.browserWindow(page);
        await page.waitForLoadState('load');

        /*
         * The real network stack, off - not Playwright's route interception, which only covers what the page asks
         * for through the renderer. Every http/https/ws request is cancelled and recorded in main, so a fetch that
         * DID happen is a URL in the report rather than an absence nobody looked for.
         */
        await app.evaluate(({ session }) => {
            const ses = session.defaultSession;
            ses.enableNetworkEmulation({ offline: true });
            const seen = [];
            ses.webRequest.onBeforeRequest(
                { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
                (details, callback) => { seen.push(details.url); callback({ cancel: true }); }
            );
            const store = /** @type {Record<string, unknown>} */ (globalThis);
            store.__offlineRequests = seen;
        });

        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        // Registered before the reload, so the violations of the RELOADED document are the ones counted.
        await page.addInitScript(() => {
            const store = /** @type {Record<string, unknown>} */ (window);
            store.__cspViolations = [];
            document.addEventListener('securitypolicyviolation', (event) => {
                store.__cspViolations.push(event.violatedDirective + ' <- ' + (event.blockedURI || 'inline'));
            });
        });

        /* Everything the app needs is reloaded from inside the bundle with the network already off. */
        await page.reload({ waitUntil: 'load' });
        await win.evaluate((browserWindow, size) => browserWindow.setContentSize(size[0], size[1]), SIZE);
        await page.waitForTimeout(300);

        for (const route of ROUTES) {
            await page.evaluate((hash) => { window.location.hash = hash; }, route.hash);
            await page.waitForFunction(
                (expected) => document.querySelector('#root h1')?.textContent?.trim() === expected,
                route.heading, { timeout: 30_000 }
            );
            await page.evaluate(() => document.fonts.ready);
            await page.waitForTimeout(250);
            const probe = await page.evaluate(probeInPage, { fonts: BUNDLED_FONTS });
            const checks = judgeRouteOffline(route.page, probe);
            routes.push({ route: route.page, probe, checks });
            const failed = checks.filter((check) => !check.pass).length;
            log(SCRIPT_NAME + ': ' + route.page + ' -> ' + (checks.length - failed) + '/' + checks.length +
                ', ' + probe.icons.length + ' icon(s)');
        }

        sound = await page.evaluate(probeSoundInPage, emittedSoundName());
        log(SCRIPT_NAME + ': sound -> ' + (sound.error === '' ? String(sound.duration) + 's' : sound.error));

        blocked = await app.evaluate(() => {
            const store = /** @type {Record<string, unknown>} */ (globalThis);
            return Array.isArray(store.__offlineRequests) ? [...store.__offlineRequests] : [];
        });
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

    return { routes, sound, blocked, consoleErrors };
}

export function summariseOffline(result) {
    const checks = [
        ...result.routes.flatMap((route) => route.checks),
        ...(result.sound === null ? [] : judgeSound(result.sound))
    ];
    return {
        routes: result.routes.length,
        checks: checks.length,
        failed: checks.filter((check) => !check.pass),
        blocked: result.blocked,
        violations: result.routes.flatMap((route) => route.probe.violations),
        consoleErrors: result.consoleErrors
    };
}

/** `app.asar/out/renderer/...` out of a file: URL, or the URL unchanged when it is not inside the package. */
export function insideThePackage(url) {
    const marker = url.indexOf('app.asar/');
    return marker === -1 ? url : url.slice(marker);
}

export function renderOfflineReport(result) {
    const summary = summariseOffline(result);
    const out = [];
    out.push('<!-- Generated by `npm run offline:check -- --write`. Do not edit by hand. -->');
    out.push('');
    out.push('# Every route, with the network off');
    out.push('');
    out.push('Phase 10 criterion 7, measured in the packaged application by `' + SCRIPT_NAME + '`. Chromium\'s own');
    out.push('network stack is put offline and every http/https/ws request cancelled and recorded before the');
    out.push('document is reloaded, so a resource that was fetched appears here as a URL rather than as an absence');
    out.push('nobody looked for.');
    out.push('');
    out.push('| | Count |');
    out.push('|---|---|');
    out.push('| Routes checked | ' + summary.routes + ' |');
    out.push('| Checks made | ' + summary.checks + ' |');
    out.push('| Checks failed | **' + summary.failed.length + '** |');
    out.push('| Remote requests attempted | ' + summary.blocked.length + ' |');
    out.push('| CSP violations reported | ' + summary.violations.length + ' |');
    out.push('| Console errors | ' + summary.consoleErrors.length + ' |');
    out.push('');

    if (summary.failed.length > 0) {
        out.push('## Failures');
        out.push('');
        out.push('| Check | Measured |');
        out.push('|---|---|');
        for (const check of summary.failed) out.push('| ' + check.label + ' | `' + check.detail + '` |');
        out.push('');
    }

    out.push('## Per route');
    out.push('');
    out.push('| Route | Icons | Widest icon | Filled | Inter | Symbols | CSP violations |');
    out.push('|---|---|---|---|---|---|---|');
    for (const route of result.routes) {
        out.push('| `' + route.route + '` | ' + route.probe.icons.length + ' | ' +
            (route.probe.icons.length === 0 ? 'n/a' : Math.max(...route.probe.icons.map((icon) => icon.ems)).toFixed(2) + 'em') + ' | ' +
            route.probe.icons.filter((icon) => icon.variation.includes(FILL_ON)).length + ' | ' +
            (route.probe.fonts['Inter Variable'] === true ? 'yes' : '**no**') + ' | ' +
            (route.probe.fonts['Material Symbols Outlined'] === true ? 'yes' : '**no**') + ' | ' +
            route.probe.violations.length + ' |');
    }
    out.push('');
    out.push('A glyph is measured with a Range over the text rather than as the element box - half these spans are');
    out.push('`block` inside a full-width navigation cell - and the bound is ' + MAX_GLYPH_EMS + 'em, because the');
    out.push('same ligature is drawn at 12px in a list row and at 48px on the play button. The control is measured');
    out.push('in the page beside it: the longest icon name, as ordinary text, at ' + MIN_NAME_EMS + 'em or more.');
    out.push('Nothing here rasterises, so what is proved is that the font resolved and the FILL axis applied - not');
    out.push('that the picture is the right picture.');
    out.push('');
    out.push('## The notification sound');
    out.push('');
    out.push('| | |');
    out.push('|---|---|');
    // Relative to the packaged archive, not absolute: the committed report must not carry one machine's paths,
    // and the staleness guard must not fail on another machine for the only reason of being on another machine.
    out.push('| Source | `' + insideThePackage(result.sound?.src ?? '') + '` |');
    out.push('| Decoded duration | ' + (result.sound?.duration ?? 0) + 's |');
    out.push('| Error | ' + (result.sound?.error === '' ? 'none' : (result.sound?.error ?? 'not probed')) + ' |');
    return out.join(NEWLINE) + NEWLINE;
}

/* ---------------------------------------------------------------------------------------- */
/* Entry                                                                                      */
/* ---------------------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const write = process.argv.slice(2).includes('--write');
    let result;
    try {
        result = await runOfflineRoutes();
    } catch (error) {
        console.error(SCRIPT_NAME + ': ' + (error.stack ?? error.message));
        console.error(SCRIPT_NAME + ': run `npm run build:unpack` first; this gate drives the packaged app.');
        process.exit(1);
    }

    const summary = summariseOffline(result);
    const report = renderOfflineReport(result);
    const normalise = (text) => text.replace(/\r\n/g, '\n');
    const committed = fs.existsSync(REPORT) ? normalise(fs.readFileSync(REPORT, 'utf8')) : '';

    if (write) {
        fs.mkdirSync(path.dirname(REPORT), { recursive: true });
        fs.writeFileSync(REPORT, report, 'utf8');
        console.log(SCRIPT_NAME + ': wrote ' + path.relative(repoRoot, REPORT));
    }

    let failed = false;
    if (summary.routes !== ROUTES.length) {
        failed = true;
        console.error(SCRIPT_NAME + ': checked ' + summary.routes + ' route(s), expected ' + ROUTES.length);
    }
    for (const check of summary.failed) {
        failed = true;
        console.error(SCRIPT_NAME + ': FAIL ' + check.label + ' -> ' + check.detail);
    }
    for (const url of summary.blocked) {
        failed = true;
        console.error(SCRIPT_NAME + ': a remote request was attempted - ' + url);
    }
    for (const violation of summary.violations) {
        failed = true;
        console.error(SCRIPT_NAME + ': CSP violation - ' + violation);
    }
    for (const line of summary.consoleErrors) {
        failed = true;
        console.error(SCRIPT_NAME + ': console error - ' + line);
    }
    if (!write && committed !== normalise(report)) {
        failed = true;
        console.error(SCRIPT_NAME + ': baselines/v2/OFFLINE-ROUTES.md is not what this run produces.');
        console.error(SCRIPT_NAME + ': re-run with --write once the difference is understood.');
    }

    if (failed) process.exit(1);
    console.log(SCRIPT_NAME + ': OK - ' + summary.routes + ' routes, ' + summary.checks +
        ' checks, 0 failed, 0 remote requests, 0 CSP violations.');
    process.exit(0);
}

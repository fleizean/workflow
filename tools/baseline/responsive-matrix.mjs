#!/usr/bin/env node
/*
 * Phase 10 criteria 1-4, as a gate over the PACKAGED app rather than a reading of the source.
 *
 *   npm run matrix:check          build:unpack first - this photographs the packaged build
 *   npm run matrix:check -- --write   rewrite the committed report after a deliberate change
 *
 * THE MATRIX IS 15 CELLS AND ALL 15 ARE MEASURED: five window sizes x three Windows display scales. The criterion
 * says "all 15 cells checked and recorded, not sampled", so the report lists every cell with its own numbers and
 * the run fails if any cell is missing, not only if one fails.
 *
 * WHAT A CELL IS, because it decides what this proves.
 *   size   the window's CONTENT size in device-independent pixels. 380x600 is exactly the floor the app refuses to
 *          be dragged below, which is where that first cell comes from.
 *   scale  --force-device-scale-factor, which is what Windows display scaling sets. At 125% a 380-DIP window is
 *          475 physical pixels wide and the renderer still lays out at 380 CSS px.
 * So the three scales do NOT change the CSS-pixel layout; they change device-pixel snapping, the fractional
 * rounding of every flex and centring computation, and devicePixelRatio - which is where the one-pixel overflow
 * and the soft canvas actually come from.
 *
 * WHAT IS CHECKED IN EACH CELL, on each of the four routes:
 *   1. no horizontal overflow  - the document is no wider than the viewport, and no visible element crosses
 *                                either edge (criterion 1);
 *   2. no clipped content      - no overflow:hidden box cuts off content it contains, and no leaf of the scroll
 *                                area sits behind the fixed bottom navigation once scrolled to its end;
 *   3. nav alignment           - the bottom bar's edges equal the content column's. v1.2.1 capped the bar at
 *                                430px and the shell at 448px;
 *   4. the timer ring          - square to within a pixel, inside the column, and sized from the space available
 *                                rather than pinned at 300px (criterion 3).
 * And once per scale, at the 380x600 floor: every modal reachable without inventing state is opened and required
 * to scroll inside itself; the Pomodoro panel is driven onto the screen through the real mode toggle; and the
 * streak fire canvas is mounted, resized and UNMOUNTED with its frame loop counted across the transition.
 *
 * WHAT IT DOES NOT PROVE. Nothing here looks at a screenshot, so "correct" means "fits, is reachable and is
 * aligned", not "is beautiful". Likeness to v1.2.1 is `npm run parity:check`'s job, and only below 448px.
 */

/* global window, document, getComputedStyle */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright-core';

import { SIZES } from './capture.mjs';
import { ROUTES, appWindow } from './capture-v2.mjs';
import { childEnvironment } from './probe-userdata.mjs';
import { SETTINGS, addDays, formatLocalDate, seedDatabase } from './seed-baseline-db.mjs';
import { unpackedBinaryPath } from '../smoke-packaged.mjs';

const SCRIPT_NAME = 'tools/baseline/responsive-matrix.mjs';
const NEWLINE = String.fromCharCode(10);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The three Windows display scales the criterion names, as Chromium's device scale factor. */
export const SCALES = [1, 1.25, 1.5];
export { SIZES };
export const CELL_COUNT = SIZES.length * SCALES.length;

/** Sub-pixel slack. Chromium reports fractional rects; a third of a device pixel is not an overflow. */
const EPSILON = 0.51;

/** The window height criterion 3 names, and the width the app cannot be dragged below. */
const MODAL_SIZE = [380, 600];

/** Enough consecutive days over the daily target to reach tier 3, so the fire canvas is on screen. */
const STREAK_DAYS = 24;
const STREAK_SECONDS = 30_600;

/*
 * Every modal this harness can reach through the real interface, as a route, an opener and a name. No
 * probe hook is added to the app for this: a dialog that can only be opened by a test is a dialog whose
 * opening is not being tested. The two that are missing are named in the report rather than omitted.
 */
const MODALS = [
    { route: '#/', name: 'Date picker', open: 'header button' },
    { route: '#/', name: 'Adjust time', open: 'text=Adjust' },
    { route: '#/', name: 'Save session', open: 'text=Save', arm: 'start-timer' },
    { route: '#/', name: 'Reset confirm', open: 'text=Reset Timer', arm: 'start-timer' },
    { route: '#/companies', name: 'Company form', open: '[aria-label="Add company"]' },
    { route: '#/history', name: 'Filter panel', open: '[aria-label="Filter sessions"]' },
    { route: '#/history', name: 'Session form', open: '[aria-label="Add session"]' },
    { route: '#/settings', name: 'About', open: 'text=About' },
    { route: '#/settings', name: 'Reset-all-data confirm', open: '[data-testid="reset-all-data"]' }
];

/** Stated in the report so the gap is visible rather than implied. */
export const MODALS_NOT_REACHED = [
    ['Restore prompt', 'needs a timer persisted by a previous launch; tools/smoke-packaged.mjs `timer` case owns that path'],
    ['Attribution prompt', 'needs a pomodoro-created session with a NULL note, which only a completed work interval writes']
];

/* ---------------------------------------------------------------------------------------- */
/* The fixture                                                                                */
/* ---------------------------------------------------------------------------------------- */

/*
 * seed-baseline-db.mjs's v1.2.1-shaped fixture, then more of it. The parity fixture is deliberately thin
 * - its streak is 1, so no fire canvas mounts and no list is long enough to scroll - and a matrix run over
 * a screen with nothing on it would find no overflow because there is nothing to overflow.
 */
function augmentFixture(file, extraDays = STREAK_DAYS) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const db = new DatabaseSync(file);
    const dates = [];
    try {
        const insert = db.prepare(
            'INSERT INTO work_sessions (name, duration, date, created_at, company_id, note) VALUES (?, ?, ?, ?, ?, ?)'
        );
        for (let back = 1; back <= extraDays; back++) {
            const date = formatLocalDate(addDays(today, -back));
            dates.push(date);
            insert.run(
                'Fixture task: a deliberately long session name, so a narrow window has something to wrap or clip',
                STREAK_SECONDS, date, date + ' 09:00:00', 2 + (back % 3),
                back % 2 === 0 ? 'Synthetic fixture note. No real work was recorded here.' : null
            );
        }
        db.prepare('INSERT INTO companies (name, created_at, updated_at, note_required) VALUES (?, ?, ?, ?)').run(
            'Fabrikam Fixture Northwind Contoso Very Long Company Name', dates[0] + ' 08:00:00',
            dates[0] + ' 08:00:00', 0
        );
    } finally {
        db.close();
    }
    return { days: extraDays, target: Number(SETTINGS.daily_target) };
}

/* ---------------------------------------------------------------------------------------- */
/* The in-page measurement                                                                    */
/* ---------------------------------------------------------------------------------------- */

/*
 * Serialised into the renderer, so it references browser globals and may close over nothing. It returns
 * numbers and paths; every verdict is reached in Node, where it can be read beside the others.
 */
function measureInPage(epsilon) {
    const pathOf = (el) => {
        const parts = [];
        for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
            const i = Array.prototype.indexOf.call(n.parentElement?.children ?? [], n);
            parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + ':nth-child(' + (i + 1) + ')');
        }
        return parts.join(' > ');
    };

    const drawn = (el, cs) => {
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };

    const shell = document.getElementById('app-shell');
    const nav = document.querySelector('nav');
    const scroller = document.querySelector('#app-shell > main');
    const rect = (el) => {
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };

    const overflowing = [];
    const clipped = [];
    for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (!drawn(el, cs)) continue;
        const r = el.getBoundingClientRect();
        const name = el.tagName.toLowerCase() + '.' + String(el.className ?? '').split(/\s+/).slice(0, 3).join('.');
        if (r.right > window.innerWidth + epsilon || r.left < -epsilon) {
            overflowing.push({
                path: pathOf(el), name,
                detail: r.left.toFixed(1) + '..' + r.right.toFixed(1) + ' of ' + window.innerWidth
            });
        }
        /*
         * A box that hides its own overflow and has more in it than it shows is cutting content off - UNLESS it
         * says so. `truncate` and a line clamp hide overflow on purpose and draw an ellipsis where the text
         * stops, which is a design decision and not a layout failure, so they are excluded by the property that
         * makes them deliberate rather than by name. Boxes one or two pixels across are the sr-only heading and
         * the hairline tab indicators, which are that size on purpose.
         */
        if (el.clientWidth < 3 || el.clientHeight < 3) continue;
        if (cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none') continue;
        const hidesX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
        const hidesY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
        if (!hidesX && !hidesY) continue;
        if (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) continue;
        /*
         * scrollWidth/scrollHeight count absolutely positioned descendants, and this design uses those as
         * decoration: every card parks its hover wash at `absolute inset-0 translate-y-full`, one box-height
         * below itself, and the play button does the same. That is what `overflow-hidden` is there to hide, and
         * reporting it would be reporting the mechanism. So the box is re-measured over its IN-FLOW descendants
         * only - the boxes that carry the content - and flagged on those.
         */
        const inner = el.getBoundingClientRect();
        const originX = inner.left + el.clientLeft - el.scrollLeft;
        const originY = inner.top + el.clientTop - el.scrollTop;
        let contentRight = 0;
        let contentBottom = 0;
        for (const child of el.querySelectorAll('*')) {
            const childStyle = getComputedStyle(child);
            if (childStyle.position === 'absolute' || childStyle.position === 'fixed') continue;
            if (!drawn(child, childStyle)) continue;
            const cr = child.getBoundingClientRect();
            contentRight = Math.max(contentRight, cr.right - originX);
            contentBottom = Math.max(contentBottom, cr.bottom - originY);
        }
        const cutX = hidesX && contentRight > el.clientWidth + 1;
        const cutY = hidesY && contentBottom > el.clientHeight + 1;
        if (cutX || cutY) {
            clipped.push({
                path: pathOf(el), name,
                detail: 'overflow ' + cs.overflow + ' in-flow content ' + contentRight.toFixed(0) + 'x' +
                    contentBottom.toFixed(0) + ' box ' + el.clientWidth + 'x' + el.clientHeight
            });
        }
    }

    /*
     * Reachability: with the scroll area driven to its end, no LEAF of it may sit under the fixed bottom
     * bar. Leaves are the text, glyphs and controls; a wrapper has children and is not itself content, so
     * counting wrappers would report the padding that exists to prevent exactly this.
     */
    const behindNav = [];
    let scrolled = null;
    if (scroller !== null && nav !== null) {
        scroller.scrollTop = scroller.scrollHeight;
        scrolled = { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
        const bar = nav.getBoundingClientRect();
        for (const el of scroller.querySelectorAll('*')) {
            if (el.childElementCount > 0) continue;
            const cs = getComputedStyle(el);
            if (!drawn(el, cs)) continue;
            const r = el.getBoundingClientRect();
            const overlapsY = r.bottom > bar.top + epsilon && r.top < bar.bottom - epsilon;
            const overlapsX = r.right > bar.left + epsilon && r.left < bar.right - epsilon;
            if (overlapsY && overlapsX) {
                behindNav.push({
                    path: pathOf(el),
                    name: el.tagName.toLowerCase() + '.' + String(el.className ?? '').split(/\s+/).slice(0, 3).join('.'),
                    detail: r.top.toFixed(1) + '..' + r.bottom.toFixed(1) + ' vs bar top ' + bar.top.toFixed(1)
                });
            }
        }
        scroller.scrollTop = 0;
    }

    const dialBox = document.querySelector('#app-shell svg[viewBox="0 0 100 100"]')?.parentElement ?? null;

    return {
        /* A dialog over the screen would make every number below a measurement of the dialog. Reported, so a
         * contaminated profile fails loudly instead of quietly lowering every cell's score by one. */
        modalOpen: document.querySelector('#modal-root [role="dialog"]') !== null,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        shell: rect(shell),
        nav: rect(nav),
        dial: rect(dialBox),
        canvas: (() => {
            const c = document.querySelector('#app-shell canvas');
            if (c === null) return null;
            const r = c.getBoundingClientRect();
            return { cssWidth: r.width, cssHeight: r.height, bitmapWidth: c.width, bitmapHeight: c.height };
        })(),
        overflowing: overflowing.slice(0, 8),
        overflowingCount: overflowing.length,
        clipped: clipped.slice(0, 8),
        clippedCount: clipped.length,
        behindNav: behindNav.slice(0, 8),
        behindNavCount: behindNav.length,
        scrolled
    };
}

function measureModalInPage(epsilon) {
    const panel = document.querySelector('#modal-root [role="dialog"]');
    if (panel === null) return { found: false };
    const r = panel.getBoundingClientRect();
    /* Modal's BODY_CLASS element: the one scroll box inside the panel. */
    const body = [...panel.children].find((child) => {
        const cs = getComputedStyle(child);
        return cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    }) ?? null;
    const overlay = panel.parentElement;
    return {
        found: true,
        panel: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
        overlay: overlay === null ? null : (() => {
            const o = overlay.getBoundingClientRect();
            return { left: o.left, right: o.right, top: o.top, bottom: o.bottom };
        })(),
        body: body === null ? null : {
            overflowY: getComputedStyle(body).overflowY,
            scrollHeight: body.scrollHeight,
            clientHeight: body.clientHeight,
            scrollbarWidth: getComputedStyle(body).scrollbarWidth
        },
        fits: r.top >= -epsilon && r.bottom <= window.innerHeight + epsilon &&
            r.left >= -epsilon && r.right <= window.innerWidth + epsilon,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
    };
}

/* ---------------------------------------------------------------------------------------- */
/* Verdicts                                                                                   */
/* ---------------------------------------------------------------------------------------- */

/** `<tag>.<first classes> (<measurement>)`, short enough to read in a table cell and specific enough to find. */
const describe = (list) => list.map((item) => item.name + ' (' + item.detail + ')').join('; ');

/** Every check a single route in a single cell must pass, with the number that decided it. */
export function judgeRoute(m, size) {
    const checks = [];
    const check = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail });

    check('the route was measured with nothing over it', !m.modalOpen,
        m.modalOpen ? 'a dialog was open - the profile is not clean' : 'no dialog');
    /*
     * At or just above the cell's size, never below it.
     *
     * Measured, not assumed: at 125% a 380x600 DIP request lands on a 382x602 CSS-pixel viewport and 430x932 on
     * 431x932; at 150% 380x600 lands on 380x601. Windows sizes the window in device pixels and the frameless
     * resize border rounds with it. BELOW the request would mean the cell is testing a narrower layout than it
     * claims, so that fails; up to four pixels above is recorded and allowed.
     */
    check('the window reached at least ' + size[0] + 'x' + size[1] + ' CSS px, and no more than 4 over',
        m.innerWidth >= size[0] && m.innerWidth <= size[0] + 4 &&
        m.innerHeight >= size[1] && m.innerHeight <= size[1] + 4,
        m.innerWidth + 'x' + m.innerHeight + ' for a requested ' + size[0] + 'x' + size[1]);
    check('the document is no wider than the viewport',
        m.documentScrollWidth <= m.innerWidth && m.bodyScrollWidth <= m.innerWidth,
        'document=' + m.documentScrollWidth + ' body=' + m.bodyScrollWidth + ' viewport=' + m.innerWidth);
    check('no drawn element crosses either edge', m.overflowingCount === 0,
        m.overflowingCount === 0 ? '0' : m.overflowingCount + ': ' + describe(m.overflowing));
    check('no overflow:hidden box cuts off what it holds', m.clippedCount === 0,
        m.clippedCount === 0 ? '0' : m.clippedCount + ': ' + describe(m.clipped));
    check('nothing sits behind the bottom bar at the end of the scroll', m.behindNavCount === 0,
        m.behindNavCount === 0 ? '0' : m.behindNavCount + ': ' + describe(m.behindNav));
    check('the bottom bar is aligned with the content column',
        m.nav !== null && m.shell !== null &&
        Math.abs(m.nav.left - m.shell.left) <= EPSILON && Math.abs(m.nav.right - m.shell.right) <= EPSILON,
        m.nav === null || m.shell === null
            ? 'nav=' + JSON.stringify(m.nav) + ' shell=' + JSON.stringify(m.shell)
            : 'nav ' + m.nav.left.toFixed(1) + '-' + m.nav.right.toFixed(1) +
              ' vs column ' + m.shell.left.toFixed(1) + '-' + m.shell.right.toFixed(1));

    if (m.dial !== null) {
        check('the timer ring keeps its aspect ratio',
            Math.abs(m.dial.width - m.dial.height) <= 1,
            m.dial.width.toFixed(1) + 'x' + m.dial.height.toFixed(1));
        check('the timer ring fits the column',
            m.shell !== null && m.dial.width <= m.shell.width + EPSILON && m.dial.height <= m.innerHeight + EPSILON,
            'ring ' + m.dial.width.toFixed(1) + ' column ' + (m.shell?.width ?? 0).toFixed(1) +
                ' viewport height ' + m.innerHeight);
    }
    if (m.canvas !== null) {
        check('the fire canvas bitmap is sized in device pixels',
            Math.abs(m.canvas.bitmapWidth - Math.round(m.canvas.cssWidth * m.devicePixelRatio)) <= 1 &&
            Math.abs(m.canvas.bitmapHeight - Math.round(m.canvas.cssHeight * m.devicePixelRatio)) <= 1,
            m.canvas.bitmapWidth + 'x' + m.canvas.bitmapHeight + ' for ' +
                m.canvas.cssWidth.toFixed(1) + 'x' + m.canvas.cssHeight.toFixed(1) + ' at dpr ' + m.devicePixelRatio);
    }
    return checks;
}

export function judgeModal(name, m) {
    const checks = [];
    const check = (label, pass, detail) => checks.push({ label, pass: Boolean(pass), detail });
    check(name + ': the dialog opened', m.found, m.found ? 'present' : 'no [role=dialog] under #modal-root');
    if (!m.found) return checks;
    check(name + ': the panel is inside the viewport', m.fits,
        'panel ' + m.panel.top.toFixed(1) + '-' + m.panel.bottom.toFixed(1) + ' of ' + m.innerHeight +
            ', ' + m.panel.left.toFixed(1) + '-' + m.panel.right.toFixed(1) + ' of ' + m.innerWidth);
    check(name + ': it scrolls inside itself rather than overflowing',
        m.body !== null && (m.body.overflowY === 'auto' || m.body.overflowY === 'scroll'),
        m.body === null ? 'no scroll box in the panel' : 'overflow-y ' + m.body.overflowY +
            ' content ' + m.body.scrollHeight + ' box ' + m.body.clientHeight);
    check(name + ': the scrollbar stays hidden, as every v1.2.1 overlay did',
        m.body !== null && m.body.scrollbarWidth === 'none',
        m.body === null ? 'no scroll box' : 'scrollbar-width ' + m.body.scrollbarWidth);
    return checks;
}

/* ---------------------------------------------------------------------------------------- */
/* Driving                                                                                    */
/* ---------------------------------------------------------------------------------------- */

async function gotoRoute(page, route) {
    await page.evaluate((hash) => { window.location.hash = hash; }, route.hash);
    await page.waitForFunction(
        (expected) => document.querySelector('#root h1')?.textContent?.trim() === expected,
        route.heading, { timeout: 30_000 }
    );
    await page.evaluate(() => document.fonts.ready);
}

/*
 * Resize, then wait for the viewport to stop moving - not for it to equal the number that was asked for.
 *
 * setContentSize takes device-independent pixels and Windows sizes the window in device pixels, so at 125% a
 * 430-DIP width is 537.5 physical, which does not exist: the window lands on 537 or 538 and the renderer reports
 * 429 or 430 CSS px back. Waiting for exact equality hangs there, and hanging on a cell is worse than failing it.
 */
async function setSize(page, win, [width, height]) {
    await win.evaluate((browserWindow, size) => browserWindow.setContentSize(size[0], size[1]), [width, height]);
    let last = null;
    for (let attempt = 0; attempt < 40; attempt++) {
        await page.waitForTimeout(100);
        const now = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
        if (last !== null && now[0] === last[0] && now[1] === last[1]) break;
        last = now;
    }
    /* The resize-driven layout and the canvas's ResizeObserver settle a frame or two later. */
    await page.waitForTimeout(150);
    return last;
}

/** Criterion 4's third clause, driven rather than read: the loop must stop when the component goes. */
async function measureFrameLoop(page) {
    await page.evaluate(() => {
        const w = /** @type {Record<string, unknown>} */ (window);
        w.__matrixFrames = 0;
        const real = window.requestAnimationFrame.bind(window);
        const realCancel = window.cancelAnimationFrame.bind(window);
        w.__matrixLive = new Set();
        window.requestAnimationFrame = (cb) => {
            const id = real((t) => {
                w.__matrixLive.delete(id);
                w.__matrixFrames = Number(w.__matrixFrames) + 1;
                cb(t);
            });
            w.__matrixLive.add(id);
            return id;
        };
        window.cancelAnimationFrame = (id) => { w.__matrixLive.delete(id); realCancel(id); };
    });
    const sample = async () => {
        await page.waitForTimeout(400);
        return page.evaluate(() => Number(window.__matrixFrames));
    };
    const mounted = await sample();
    const afterMounted = await sample();
    /* Leave Home. StreakFireCanvas unmounts with it; nothing else in the app animates on a frame loop. */
    await page.evaluate(() => { window.location.hash = '#/settings'; });
    await page.waitForFunction(
        () => document.querySelector('#root h1')?.textContent?.trim() === 'Settings', undefined, { timeout: 30_000 }
    );
    await page.waitForTimeout(400);
    const settled = await page.evaluate(() => Number(window.__matrixFrames));
    await page.waitForTimeout(600);
    const afterUnmount = await page.evaluate(() => Number(window.__matrixFrames));
    return {
        whileMounted: afterMounted - mounted,
        afterUnmount: afterUnmount - settled,
        pending: await page.evaluate(() => Number(window.__matrixLive.size))
    };
}

async function measureModals(page, win, log) {
    const checks = [];
    await setSize(page, win, MODAL_SIZE);
    let armed = false;

    for (const modal of MODALS) {
        const route = ROUTES.find((r) => r.hash === modal.route);
        await gotoRoute(page, route);
        if (modal.arm === 'start-timer' && !armed) {
            await page.click('[aria-label="Start the timer"]');
            /* The Save and Reset controls are dead until the clock holds something. */
            await page.waitForSelector('text=Reset Timer >> nth=0', { timeout: 15_000 });
            await page.waitForFunction(
                () => document.querySelectorAll('button:disabled').length === 0, undefined, { timeout: 20_000 }
            );
            await page.click('[aria-label="Pause the timer"]');
            armed = true;
        }
        await page.click(modal.open);
        await page.waitForSelector('#modal-root [role="dialog"]', { timeout: 15_000 });
        await page.waitForTimeout(200);
        const measured = await page.evaluate(measureModalInPage, EPSILON);
        checks.push(...judgeModal(modal.name, measured));
        log(SCRIPT_NAME + ':   modal ' + modal.name + ' -> ' +
            (measured.found ? measured.panel.height.toFixed(0) + 'px tall' : 'NOT OPENED'));
        await page.keyboard.press('Escape');
        await page.waitForSelector('#modal-root [role="dialog"]', { state: 'detached', timeout: 15_000 });
    }
    return checks;
}

/*
 * The Pomodoro panel has never been rendered by anything in this repository - not by a test, and not by
 * the packaged smoke, which launches in work mode. This drives the real mode toggle and asserts the panel
 * arrived, which is the first time that component is known to render at all.
 */
async function measurePomodoroPanel(page, win, log) {
    await setSize(page, win, MODAL_SIZE);
    await gotoRoute(page, ROUTES[0]);
    await page.click('button[aria-pressed="false"] >> nth=0');
    await page.waitForFunction(
        () => document.querySelector('button[aria-pressed="true"]') !== null, undefined, { timeout: 20_000 }
    );
    await page.waitForTimeout(400);
    const seen = await page.evaluate(() => {
        const root = document.getElementById('root');
        const text = root?.textContent ?? '';
        const rings = document.querySelectorAll('#app-shell svg[viewBox="0 0 100 100"]').length;
        const buttons = [...document.querySelectorAll('#app-shell button')]
            .map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).filter((t) => t !== '');
        return { text: text.slice(0, 4000), rings, buttons };
    });
    /* Back to work mode, so the modal pass that follows finds the screen it expects. */
    await page.click('button[aria-pressed="true"] >> nth=0');
    await page.waitForFunction(
        () => document.querySelector('button[aria-pressed="true"]') === null, undefined, { timeout: 20_000 }
    );
    log(SCRIPT_NAME + ':   pomodoro panel -> ' + seen.rings + ' ring(s), ' + seen.buttons.length + ' control(s)');
    const has = (needle) => seen.text.toLowerCase().includes(needle);
    return [
        { label: 'the Pomodoro panel rendered its own dial', pass: seen.rings >= 1, detail: seen.rings + ' ring(s)' },
        {
            label: 'the Pomodoro panel named the cycle it is in',
            pass: has('focus') || has('work') || has('break'),
            detail: JSON.stringify(seen.text.replace(/\s+/g, ' ').slice(0, 160))
        },
        {
            label: 'the Pomodoro panel offered controls',
            pass: seen.buttons.length >= 5,
            detail: seen.buttons.slice(0, 10).join(' | ')
        }
    ];
}

/* ---------------------------------------------------------------------------------------- */
/* One launch per scale                                                                       */
/* ---------------------------------------------------------------------------------------- */

async function runScale({ binary, scale, fixtureDir, log }) {
    const { env, removed } = childEnvironment();
    if (removed.length > 0) log(SCRIPT_NAME + ': scrubbed from the child environment -> ' + removed.join(', '));

    const cells = [];
    const extras = [];
    const consoleErrors = [];
    const violations = [];
    const remote = [];
    let app = null;

    try {
        app = await electron.launch({
            executablePath: binary,
            env,
            args: [
                '--no-sandbox',
                '--user-data-dir=' + fixtureDir,
                '--force-device-scale-factor=' + String(scale),
                '--disable-lcd-text'
            ],
            timezoneId: 'Europe/Istanbul',
            locale: 'tr-TR',
            colorScheme: 'dark'
        });

        const page = await appWindow(app);
        const win = await app.browserWindow(page);
        page.on('request', (request) => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
            if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
        });
        await page.waitForLoadState('load');
        await page.addInitScript(() => {
            /* Reported in Node; the console route misses a violation Chromium reports only as an event. */
            document.addEventListener('securitypolicyviolation', (event) => {
                const w = /** @type {Record<string, unknown>} */ (window);
                const list = Array.isArray(w.__cspViolations) ? w.__cspViolations : [];
                list.push(event.violatedDirective + ' <- ' + event.blockedURI);
                w.__cspViolations = list;
            });
        });

        for (const size of SIZES) {
            await setSize(page, win, size);
            const routes = [];
            for (const route of ROUTES) {
                await gotoRoute(page, route);
                await page.waitForTimeout(120);
                const measured = await page.evaluate(measureInPage, EPSILON);
                const checks = judgeRoute(measured, size);
                routes.push({ route: route.page, measured, checks });
                const failed = checks.filter((c) => !c.pass).length;
                log(SCRIPT_NAME + ':   ' + size[0] + 'x' + size[1] + ' @' + scale + ' ' + route.page +
                    ' -> ' + (checks.length - failed) + '/' + checks.length);
            }
            cells.push({ scale, size, routes });
        }

        extras.push(...await measurePomodoroPanel(page, win, log));
        extras.push(...await measureModals(page, win, log));

        await setSize(page, win, MODAL_SIZE);
        await gotoRoute(page, ROUTES[0]);
        const loop = await measureFrameLoop(page);
        log(SCRIPT_NAME + ':   frame loop -> ' + loop.whileMounted + ' while mounted, ' +
            loop.afterUnmount + ' after unmount');
        extras.push({
            label: 'the fire canvas really was animating before the unmount',
            /*
             * The count is in the run's own output, not in the report: how many frames land in 400 ms depends on
             * what else the machine is doing, and a committed report that changes by a frame between two identical
             * runs is a staleness guard that cries wolf. What is recorded is the fact, which is stable.
             */
            pass: loop.whileMounted > 0,
            detail: loop.whileMounted > 0 ? 'frames were requested while it was mounted' : 'no frame was ever requested'
        });
        extras.push({
            label: 'the fire canvas cancels its frame loop on unmount',
            pass: loop.afterUnmount === 0 && loop.pending === 0,
            detail: loop.afterUnmount + ' frame(s) after leaving Home, ' + loop.pending + ' uncancelled request(s)'
        });

        const pageViolations = await page.evaluate(
            () => (Array.isArray(window.__cspViolations) ? window.__cspViolations : [])
        );
        violations.push(...pageViolations);
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

    return { scale, cells, extras, consoleErrors, violations, remote };
}

export async function runMatrix(options = {}) {
    const log = options.quiet ? () => {} : (...parts) => { console.log(...parts); };
    const scales = options.scales ?? SCALES;
    const distDir = path.resolve(options.distDir ?? path.join(repoRoot, 'dist'));
    const binary = unpackedBinaryPath(distDir, process.platform, process.arch);
    if (!fs.existsSync(binary)) {
        throw new Error('no unpacked build at ' + binary + ' - run `npm run build:unpack` first');
    }

    /*
     * A FRESH fixture per scale, not one shared across the three launches. The modal pass starts and pauses the
     * work timer to arm Save and Reset, which persists accumulated seconds into app_state - so the next launch
     * over the same profile restored them and opened the RestorePrompt on its first paint, before a single cell
     * was measured. That is the app behaving correctly and the harness measuring a screen with a dialog over it.
     * Three profiles, three unpolluted launches.
     */
    const runs = [];
    const roots = [];
    let fixture = null;
    try {
        for (const scale of scales) {
            const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-matrix-'));
            roots.push(fixtureRoot);
            const fixtureDir = path.join(fixtureRoot, 'ud');
            const seeded = seedDatabase(fixtureDir);
            const extra = augmentFixture(seeded.file);
            fixture = { ...extra, today: seeded.dates.today };
            log(SCRIPT_NAME + ': launching at device scale factor ' + scale + ' over ' + seeded.file +
                ' (+' + extra.days + ' streak days over ' + extra.target + 's)');
            runs.push(await runScale({ binary, scale, fixtureDir, log }));
        }
    } finally {
        for (const root of roots) {
            try {
                fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
            } catch (error) {
                log(SCRIPT_NAME + ': could not remove ' + root + ' (' + error.code + '); harmless');
            }
        }
    }
    return { runs, fixture };
}

/* ---------------------------------------------------------------------------------------- */
/* The report                                                                                 */
/* ---------------------------------------------------------------------------------------- */

export function summarise(result) {
    const cells = result.runs.flatMap((run) => run.cells);
    const routeChecks = cells.flatMap((cell) => cell.routes.flatMap((r) => r.checks));
    const extraChecks = result.runs.flatMap((run) => run.extras);
    const all = [...routeChecks, ...extraChecks];
    return {
        cells: cells.length,
        expectedCells: CELL_COUNT,
        checks: all.length,
        failed: all.filter((c) => !c.pass),
        remote: result.runs.flatMap((run) => run.remote),
        violations: result.runs.flatMap((run) => run.violations),
        consoleErrors: result.runs.flatMap((run) => run.consoleErrors)
    };
}

const verdict = (checks) => (checks.every((c) => c.pass) ? 'PASS' : 'FAIL');

export function renderMatrixReport(result) {
    const out = [];
    const summary = summarise(result);
    out.push('<!-- Generated by `npm run matrix:check -- --write`. Do not edit by hand. -->');
    out.push('');
    out.push('# The 15-cell responsive matrix');
    out.push('');
    out.push('Phase 10 criteria 1-4, measured in the packaged application by `' + SCRIPT_NAME + '`. Five window');
    out.push('content sizes in device-independent pixels x three Windows display scales, four routes in every');
    out.push('cell. Every cell is listed: the criterion asks for all 15 checked and recorded, not sampled.');
    out.push('');
    out.push('| | Count |');
    out.push('|---|---|');
    out.push('| Cells measured | ' + summary.cells + ' of ' + summary.expectedCells + ' |');
    out.push('| Checks made | ' + summary.checks + ' |');
    out.push('| Checks failed | **' + summary.failed.length + '** |');
    out.push('| Remote requests attempted | ' + summary.remote.length + ' |');
    out.push('| CSP violations reported | ' + summary.violations.length + ' |');
    out.push('');

    if (summary.failed.length > 0) {
        out.push('## Failures');
        out.push('');
        out.push('| Check | Measured |');
        out.push('|---|---|');
        for (const c of summary.failed) out.push('| ' + c.label + ' | `' + c.detail + '` |');
        out.push('');
    }

    out.push('## The 15 cells');
    out.push('');
    out.push('`Physical` is the DIP size times the scale; `CSS px` is what the renderer actually reported. They');
    out.push('disagree by a pixel or two at 125% and 150%, because Windows sizes the window in device pixels and a');
    out.push('fractional scale has no exact CSS-pixel equivalent for every size. The viewport is never SMALLER than');
    out.push('the cell asks for, which is the direction that would weaken the claim.');
    out.push('');
    out.push('| Size (DIP) | Scale | Physical | CSS px | dpr | Home | Companies | Work History | Settings |');
    out.push('|---|---|---|---|---|---|---|---|---|');
    for (const run of result.runs) {
        for (const cell of run.cells) {
            const first = cell.routes[0]?.measured;
            const physical = Math.round(cell.size[0] * cell.scale) + 'x' + Math.round(cell.size[1] * cell.scale);
            out.push('| ' + cell.size[0] + 'x' + cell.size[1] + ' | ' + Math.round(cell.scale * 100) + '% | ' +
                physical + ' | ' + (first?.innerWidth ?? '?') + 'x' + (first?.innerHeight ?? '?') + ' | ' +
                (first?.devicePixelRatio ?? '?') + ' | ' +
                cell.routes.map((r) => verdict(r.checks)).join(' | ') + ' |');
        }
    }
    out.push('');
    out.push('## Per-cell geometry');
    out.push('');
    out.push('| Size | Scale | Route | Content column | Bottom bar | Ring | Overflow | Clipped | Behind the bar |');
    out.push('|---|---|---|---|---|---|---|---|---|');
    for (const run of result.runs) {
        for (const cell of run.cells) {
            for (const r of cell.routes) {
                const m = r.measured;
                const span = (box) => (box === null ? 'n/a' : box.left.toFixed(1) + '-' + box.right.toFixed(1));
                out.push('| ' + cell.size[0] + 'x' + cell.size[1] + ' | ' + Math.round(cell.scale * 100) + '% | ' +
                    r.route + ' | ' + span(m.shell) + ' | ' + span(m.nav) + ' | ' +
                    (m.dial === null ? 'n/a' : m.dial.width.toFixed(0) + 'x' + m.dial.height.toFixed(0)) + ' | ' +
                    m.overflowingCount + ' | ' + m.clippedCount + ' | ' + m.behindNavCount + ' |');
            }
        }
    }
    out.push('');
    out.push('## What each launch also proved');
    out.push('');
    out.push('| Scale | Check | Measured |');
    out.push('|---|---|---|');
    for (const run of result.runs) {
        for (const c of run.extras) {
            out.push('| ' + Math.round(run.scale * 100) + '% | ' + (c.pass ? '' : '**FAIL** ') + c.label +
                ' | `' + c.detail + '` |');
        }
    }
    out.push('');
    out.push('## Modals this harness cannot reach');
    out.push('');
    out.push('| Dialog | Why |');
    out.push('|---|---|');
    for (const [name, why] of MODALS_NOT_REACHED) out.push('| ' + name + ' | ' + why + ' |');
    out.push('');
    out.push('Both are measured by `Modal`\'s own bounds, which every dialog shares, so what is unproven for them');
    out.push('is that their CONTENT fits - not that the panel does.');
    return out.join(NEWLINE) + NEWLINE;
}

/* ---------------------------------------------------------------------------------------- */
/* Entry                                                                                      */
/* ---------------------------------------------------------------------------------------- */

const REPORT = path.join(repoRoot, 'baselines', 'v2', 'RESPONSIVE-MATRIX.md');

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const argv = process.argv.slice(2);
    const write = argv.includes('--write');
    const scaleArg = argv.find((a) => a.startsWith('--scale='));
    const distArg = argv.find((a) => a.startsWith('--dist='));

    let result;
    try {
        result = await runMatrix({
            scales: scaleArg ? scaleArg.slice('--scale='.length).split(',').map(Number) : undefined,
            distDir: distArg ? distArg.slice('--dist='.length) : undefined
        });
    } catch (error) {
        console.error(SCRIPT_NAME + ': ' + (error.stack ?? error.message));
        console.error(SCRIPT_NAME + ': run `npm run build:unpack` first; this gate drives the packaged app.');
        process.exit(1);
    }

    const summary = summarise(result);
    const report = renderMatrixReport(result);
    const normalise = (text) => text.replace(/\r\n/g, '\n');
    const committed = fs.existsSync(REPORT) ? normalise(fs.readFileSync(REPORT, 'utf8')) : '';

    if (write) {
        fs.mkdirSync(path.dirname(REPORT), { recursive: true });
        fs.writeFileSync(REPORT, report, 'utf8');
        console.log(SCRIPT_NAME + ': wrote ' + path.relative(repoRoot, REPORT));
    }

    let failed = false;
    if (summary.cells !== summary.expectedCells) {
        failed = true;
        console.error(SCRIPT_NAME + ': measured ' + summary.cells + ' cells, expected ' + summary.expectedCells +
            ' - the matrix was sampled, not checked');
    }
    for (const check of summary.failed) {
        failed = true;
        console.error(SCRIPT_NAME + ': FAIL ' + check.label + ' -> ' + check.detail);
    }
    if (summary.remote.length > 0) {
        failed = true;
        console.error(SCRIPT_NAME + ': the app attempted ' + summary.remote.length + ' remote request(s)');
    }
    if (summary.violations.length > 0) {
        failed = true;
        for (const v of summary.violations.slice(0, 10)) console.error(SCRIPT_NAME + ': CSP violation - ' + v);
    }
    if (!write && committed !== normalise(report)) {
        failed = true;
        console.error(SCRIPT_NAME + ': baselines/v2/RESPONSIVE-MATRIX.md is not what this run produces.');
        /*
         * Naming the lines rather than only the fact. The gate first failed on a CI runner, where
         * `--write` is not a thing anyone can re-run and the operator has nothing to reason from;
         * every recorded value here is a measurement, so a machine that renders a pixel differently
         * has to be distinguishable from a screen that actually broke.
         */
        const was = committed.split('\n');
        const now = normalise(report).split('\n');
        let shown = 0;
        for (let n = 0; n < Math.max(was.length, now.length) && shown < 20; n += 1) {
            if (was[n] === now[n]) continue;
            shown += 1;
            console.error(SCRIPT_NAME + ': line ' + (n + 1) + ' committed: ' + (was[n] ?? '(no line)'));
            console.error(SCRIPT_NAME + ': line ' + (n + 1) + ' this run : ' + (now[n] ?? '(no line)'));
        }
        const total = Math.max(was.length, now.length);
        if (shown === 20) console.error(SCRIPT_NAME + ': ...more differences past line ' + total);
        console.error(SCRIPT_NAME + ': re-run with --write once the difference is understood.');
    }

    if (failed) process.exit(1);
    console.log(SCRIPT_NAME + ': OK - ' + summary.cells + ' cells, ' + summary.checks +
        ' checks, 0 failed, the report matches.');
    process.exit(0);
}

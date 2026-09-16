#!/usr/bin/env node
/*
 * Criterion 2's second gate, as a computation: diff the v2 SPA's computed styles against the Phase 1
 * baselines under baselines/v1.2.1/computed/.
 *
 *   node tools/baseline/capture-v2.mjs --out=DIR
 *   node tools/baseline/diff-computed.mjs --v2=DIR [--report=FILE]
 *
 * WHY THIS IS NOT AN ELEMENT-BY-ELEMENT DIFF. The baseline keys every element by its position in the
 * document (`tag#id:nth-child(n) > ...`). v1.2.1 was four hand-written HTML documents and v2 is one
 * React tree, so almost no key exists on both sides - a keyed diff would report "100% different" and
 * mean nothing. What the baseline is actually FOR is named in capture.mjs's own header: catching the
 * silent Tailwind v4 regressions - a renamed scale step, a changed Preflight default - none of which
 * is visible to an eyeball. Those show up as a VALUE that v1.2.1 rendered and v2 renders nowhere, or
 * the reverse. So this diffs the value vocabulary of each property, per page, unioned over the five
 * sizes.
 *
 * WHAT IS NORMALISED FIRST, AND WHY EACH IS NOT A DIFFERENCE:
 *
 *  - COLOUR NOTATION. Tailwind v3 shipped its palette as rgb(); v4 ships the same palette as oklch(),
 *    and getComputedStyle returns the notation that was specified. slate-400 is `rgb(148, 163, 184)`
 *    under v3 and `oklch(0.704 0.04 256.788)` under v4 - one colour, two spellings. Every colour is
 *    resolved to 8-bit sRGB before comparison, so a real colour change still fails.
 *  - EMPTY SHADOW SLOTS. v4's shadow chain carries more always-transparent slots than v3's, so the
 *    same shadow reads as five comma-separated parts instead of three. Fully transparent zero-size
 *    parts draw nothing and are dropped from both sides.
 *  - OUTLINE WIDTH UNDER `outline-style: none`. CSS 2.1 computed outline-width to 0 when the style is
 *    none; current Chromium keeps the specified width. Both records say `none`, so neither draws an
 *    outline; the width is normalised to 0 when the style is none. This is Chromium 120 vs 152, not
 *    the rewrite.
 *  - `rounded-full`. v3 emitted 9999px, v4 emits calc(infinity * 1px) -> 3.35544e+07px. Both exceed
 *    half of any element on any of these screens, so both draw the same pill.
 *
 * WHAT IS DELIBERATELY NOT A GATE. The twelve geometry properties (width, height, margin, padding,
 * gap, flex, grid-template-columns, transform, display, position, overflow, z-index) are reported as
 * counts only. The DOM differs by construction - v1.2.1 kept every modal in the markup and v2 mounts
 * each one only while it opens - and the content column is 40rem where the v1.2.1 column was 448px
 * (owner, 2026-09-14), so above 448px these baselines have nothing left to match. A geometry
 * vocabulary difference is therefore evidence of nothing either way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'tools/baseline/diff-computed.mjs';
const NEWLINE = String.fromCharCode(10);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PAGES = ['index', 'companies', 'work-history', 'settings'];
export const SIZES = ['380x600', '430x932', '768x1024', '1280x800', '1920x1080'];

/** The properties a Tailwind rename or a changed default would move. These are the gate. */
export const DESIGN_PROPS = [
    'color', 'background-color', 'border', 'border-radius', 'box-shadow', 'font-family',
    'font-size', 'font-weight', 'line-height', 'letter-spacing', 'opacity', 'outline'
];

/** Reported, never a gate - see the header. */
export const GEOMETRY_PROPS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'flex',
    'grid-template-columns', 'gap', 'overflow', 'z-index', 'transform'
];

/* ---------------------------------------------------------------------------------------- */
/* Colour                                                                                     */
/* ---------------------------------------------------------------------------------------- */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Linear-light sRGB channel to the 0..1 gamma-encoded value. */
function gammaEncode(c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Oklab to 8-bit sRGB. The matrices are the ones in the CSS Color 4 specification. */
export function oklabToSrgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return [lr, lg, lb].map((c) => Math.round(clamp01(gammaEncode(c)) * 255));
}

const num = (token) => {
    const t = token.trim();
    if (t.endsWith('%')) return Number.parseFloat(t) / 100;
    if (t.endsWith('deg')) return Number.parseFloat(t);
    return Number.parseFloat(t);
};

/** `1`, `0.5`, `50%`, `none` -> 0..1. */
const alphaOf = (token) => (token === undefined || token === null ? 1 : clamp01(num(token)));

const hex = (rgb, alpha) =>
    '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('') +
    Math.round(clamp01(alpha) * 255).toString(16).padStart(2, '0');

/*
 * One colour function -> #rrggbbaa. Handles the four notations these records actually contain:
 * rgb(), rgba(), oklab() and oklch(), in both comma and space syntax, with an optional `/ alpha`.
 */
export function colourToHex(fn, body) {
    const parts = body.replace(/\//g, ' / ').split(/[\s,]+/).filter((t) => t !== '');
    const slash = parts.indexOf('/');
    const channels = slash === -1 ? parts : parts.slice(0, slash);
    const alpha = slash === -1
        ? (channels.length > 3 ? alphaOf(channels[3]) : 1)
        : alphaOf(parts[slash + 1]);
    const c = channels.slice(0, 3).map(num);
    if (fn === 'rgb' || fn === 'rgba') return hex(c.map((v) => Math.round(v)), alpha);
    if (fn === 'oklab') return hex(oklabToSrgb(c[0], c[1], c[2]), alpha);
    if (fn === 'oklch') {
        const h = (c[2] * Math.PI) / 180;
        return hex(oklabToSrgb(c[0], c[1] * Math.cos(h), c[1] * Math.sin(h)), alpha);
    }
    return null;
}

/** Every colour function in a declaration, resolved to #rrggbbaa in place. */
export function resolveColours(value) {
    return value.replace(
        /\b(rgba?|oklab|oklch)\(([^()]*)\)/g,
        (whole, fn, body) => colourToHex(fn, body) ?? whole
    );
}

/* ---------------------------------------------------------------------------------------- */
/* Per-property normalisation                                                                 */
/* ---------------------------------------------------------------------------------------- */

const TRANSPARENT_SLOT = /^#00000000 0px 0px 0px 0px$/;
/* v3's rounded-full is 9999px; v4's is calc(infinity * 1px), which Chromium reports as 3.35544e+07px. */
const FULL_RADIUS_PX = 9999;

export function normalise(prop, rawValue) {
    let value = resolveColours(String(rawValue).trim());

    if (prop === 'box-shadow') {
        const kept = splitTopLevel(value).map((part) => part.trim()).filter((part) => !TRANSPARENT_SLOT.test(part));
        value = kept.length === 0 ? 'none' : kept.join(', ');
    }

    if (prop === 'outline') {
        /* `<color> <style> <width>`: with style none nothing is drawn, whatever the width says. */
        const m = value.match(/^(\S+)\s+(\S+)\s+(\S+)$/);
        if (m && m[2] === 'none') value = m[1] + ' none 0px';
    }

    if (prop === 'border-radius') {
        value = value.replace(/([\d.e+]+)px/gi, (whole, n) =>
            (Number.parseFloat(n) >= FULL_RADIUS_PX ? 'full' : whole));
    }

    return value;
}

/** Split on commas that are not inside parentheses. */
export function splitTopLevel(value) {
    const out = [];
    let depth = 0;
    let current = '';
    for (const ch of value) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
        current += ch;
    }
    out.push(current);
    return out;
}

/* ---------------------------------------------------------------------------------------- */
/* Visibility                                                                                 */
/* ---------------------------------------------------------------------------------------- */

/*
 * v1.2.1 carried every modal in the page markup with `hidden` on it; v2 mounts a modal when it opens.
 * Counting a closed dialog's font sizes as "v1.2.1 rendered this and v2 does not" would be false -
 * v1.2.1 did not render it either. An element is visible when neither it nor any ancestor computes
 * display: none, which the record's own hierarchical keys make decidable without the DOM.
 */
export function visibleKeys(record) {
    const hiddenRoots = Object.entries(record)
        .filter(([, styles]) => styles.display === 'none')
        .map(([key]) => key);
    return Object.keys(record).filter((key) => {
        if (key === '') return false;
        return !hiddenRoots.some((root) => key === root || key.startsWith(root + ' > '));
    });
}

/* ---------------------------------------------------------------------------------------- */
/* The settled register                                                                       */
/* ---------------------------------------------------------------------------------------- */

/*
 * Every difference is either a deviation the owner settled or a defect - there is no third
 * category, and "close enough" is not a verdict. So each surviving difference is named here with
 * its reason, and anything NOT named fails the run. That is what makes this a gate rather than a
 * reading: a future change either matches the baselines or arrives in the unexplained list.
 *
 * `side` is which capture carries the value: `v1` for something only v1.2.1 rendered, `v2` for
 * something only the SPA renders.
 */
export const SETTLED = [
    /* 1. Owner removed the Google Sheets export (2026-09-11), so its whole surface is gone. */
    { page: 'settings', prop: 'color', side: 'v1', value: '#34d399ff',
        why: 'the Export-in-0.5h-increments row icon (legacy settings.html:277) - owner-removed export' },
    { page: 'settings', prop: 'outline', side: 'v1', value: '#34d399ff none 0px', why: 'as above' },
    { page: 'settings', prop: 'background-color', side: 'v1', value: '#10b98133',
        why: 'the same row icon tile - owner-removed export' },
    { page: 'settings', prop: 'color', side: 'v1', value: '#8b5cf6ff',
        why: 'the Script URL row code glyph (legacy settings.html:305) - owner-removed export' },
    { page: 'settings', prop: 'outline', side: 'v1', value: '#8b5cf6ff none 0px', why: 'as above' },
    { page: 'settings', prop: 'border', side: 'v1', value: '1px solid #3b82f633',
        why: 'the Setup Instructions button (legacy settings.html:315) - owner-removed export' },
    { page: 'settings', prop: 'font-size', side: 'v1', value: '14px',
        why: 'the Script URL input and the Setup Instructions caption - owner-removed export' },
    { page: 'settings', prop: 'font-size', side: 'v1', value: '22px',
        why: 'the Setup Instructions glyph - owner-removed export' },
    { page: 'settings', prop: 'line-height', side: 'v1', value: '22px', why: 'as above' },
    { page: 'work-history', prop: 'box-shadow', side: 'v1',
        value: '#10b98133 0px 10px 15px -3px, #10b98133 0px 4px 6px -4px',
        why: 'the Export Day End button - owner-removed export (08-B-SUMMARY.md)' },

    /* 2. Recorded in the slice summaries, which the brief names as the register for the rest. */
    { page: 'settings', prop: 'color', side: 'v1', value: '#475569ff',
        why: 'the hand-edited "Version 1.2.1" line, dropped deliberately (08-E-SUMMARY.md); Phase 10 owns the real one' },
    { page: 'settings', prop: 'outline', side: 'v1', value: '#475569ff none 0px', why: 'as above' },
    { page: 'index', prop: 'background-color', side: 'v2', value: '#101c22f2',
        why: 'Home\'s header is sticky with the backdrop the other three screens already had (08-C-SUMMARY.md); ' +
            'AppShell owns the one scroller, so a header outside it is not available' },
    { page: 'index', prop: 'opacity', side: 'v1', value: '0.75',
        why: 'the status badge ping, which carries the RUNNING state here rather than being hidden on pause ' +
            '(08-C-SUMMARY.md); the capture is not running' },

    /* 3. Forced by constraints outside this phase. */
    ...PAGES.map((page) => ({ page, prop: 'font-family', side: 'v1', value: 'Inter, sans-serif',
        why: 'the same typeface under the name the self-hosted package declares - S4/offline requires the font ' +
            'inside the bundle, and @fontsource-variable/inter names its family "Inter Variable"' })),
    ...PAGES.map((page) => ({ page, prop: 'font-family', side: 'v2', value: '"Inter Variable", Inter, sans-serif',
        why: 'as above' })),

    /*
     * 4. Found by this diff, judged to stand, each with its reason. None is a colour, a size or a
     * shape the user sees differently by accident.
     */
    { page: 'index', prop: 'color', side: 'v1', value: '#64748bff',
        why: 'the dial headline when the daily target is EXCEEDED, which the fixture is. legacy index.html:909-910 ' +
            'asks for text-red-400 there, and its own `dark:text-slate-500` outranks it two classes to one, so the ' +
            'red never drew in dark mode - the baseline is the evidence. v2 swaps the whole class string and shows ' +
            'the red v1.2.1 asked for. Reproducing the specificity failure would be reimplementing a broken behaviour' },
    { page: 'index', prop: 'outline', side: 'v1', value: '#64748bff none 0px', why: 'as above' },
    { page: 'index', prop: 'color', side: 'v2', value: '#f87171ff', why: 'as above, the other side of it' },
    { page: 'index', prop: 'outline', side: 'v2', value: '#f87171ff none 0px', why: 'as above' },
    { page: 'index', prop: 'opacity', side: 'v1', value: '0',
        why: 'v1.2.1 always mounted #streakFireCanvas and left it at opacity 0 below the first tier; ' +
            'StreakFireCanvas mounts only from tier 1. The fixture streak is 1, so v2 draws nothing where v1.2.1 ' +
            'drew nothing visible' },
    { page: 'index', prop: 'opacity', side: 'v2', value: '0.4',
        why: 'SAVE and RESET TIMER are disabled at 40% while no time is counted. v1.2.1 left them live and answered ' +
            'a press with "No time to save!" - the refusal is the same, the button says so before it is pressed. ' +
            'Noted against checklist rows 13 and 17' },
    { page: 'settings', prop: 'border', side: 'v1', value: '0px none #6b7280ff',
        why: '@tailwindcss/forms sets border-style on a control; both sides are 0px wide, so neither draws a border. ' +
            'v1.2.1 reported `none`, v2 reports `solid`' }
];

/* ---------------------------------------------------------------------------------------- */
/* Diff                                                                                       */
/* ---------------------------------------------------------------------------------------- */

function vocabulary(record, props, keys) {
    const out = new Map(props.map((p) => [p, new Set()]));
    for (const key of keys) {
        const styles = record[key];
        for (const prop of props) out.get(prop).add(normalise(prop, styles[prop] ?? ''));
    }
    return out;
}

export function diffPage(baselineDir, v2Dir, page, props) {
    const base = new Map(props.map((p) => [p, new Set()]));
    const v2 = new Map(props.map((p) => [p, new Set()]));
    for (const size of SIZES) {
        const stem = page + '@' + size + '.json';
        const b = JSON.parse(fs.readFileSync(path.join(baselineDir, stem), 'utf8'));
        const n = JSON.parse(fs.readFileSync(path.join(v2Dir, stem), 'utf8'));
        const bv = vocabulary(b, props, visibleKeys(b));
        const nv = vocabulary(n, props, visibleKeys(n));
        for (const prop of props) {
            for (const value of bv.get(prop)) base.get(prop).add(value);
            for (const value of nv.get(prop)) v2.get(prop).add(value);
        }
    }
    const rows = [];
    for (const prop of props) {
        const lost = [...base.get(prop)].filter((v) => !v2.get(prop).has(v)).sort();
        const gained = [...v2.get(prop)].filter((v) => !base.get(prop).has(v)).sort();
        if (lost.length > 0 || gained.length > 0) rows.push({ prop, lost, gained });
    }
    return rows;
}

/** The register entry explaining a difference, or undefined when nothing explains it. */
export function settledReason(page, prop, side, value) {
    return SETTLED.find((entry) =>
        entry.page === page && entry.prop === prop && entry.side === side && entry.value === value);
}

/** Every difference on a page, each either carrying its reason or standing unexplained. */
export function classifyPage(baselineDir, v2Dir, page, props, explain) {
    const settled = [];
    const unexplained = [];
    for (const row of diffPage(baselineDir, v2Dir, page, props)) {
        for (const [side, values] of [['v1', row.lost], ['v2', row.gained]]) {
            for (const value of values) {
                const entry = explain ? settledReason(page, row.prop, side, value) : undefined;
                (entry ? settled : unexplained).push({ page, prop: row.prop, side, value, why: entry?.why });
            }
        }
    }
    return { settled, unexplained };
}

export function run(options = {}) {
    const baselineDir = options.baselineDir ?? path.join(repoRoot, 'baselines', 'v1.2.1', 'computed');
    const v2Dir = options.v2Dir;
    if (!v2Dir || !fs.existsSync(v2Dir)) {
        throw new Error('--v2=DIR must name a directory of v2 computed-style records');
    }
    const design = {};
    const geometry = {};
    for (const page of PAGES) {
        design[page] = classifyPage(baselineDir, v2Dir, page, DESIGN_PROPS, true);
        geometry[page] = classifyPage(baselineDir, v2Dir, page, GEOMETRY_PROPS, false);
    }
    return { design, geometry };
}

export function renderReport(result) {
    const out = [];
    const settled = PAGES.flatMap((page) => result.design[page].settled);
    const unexplained = PAGES.flatMap((page) => result.design[page].unexplained);
    const geometry = PAGES.reduce((n, page) => n + result.geometry[page].unexplained.length, 0);
    const by = (side) => (side === 'v1' ? 'v1.2.1 only' : 'v2 only');

    out.push('<!-- Generated by `node ' + SCRIPT_NAME + ' --v2=DIR --report=FILE`. Do not edit by hand. -->');
    out.push('');
    out.push('# v2 against the v1.2.1 computed-style baselines');
    out.push('');
    out.push('Phase 8 criterion 2, second gate: the v2 SPA captured by `tools/baseline/capture-v2.mjs` at the four');
    out.push('routes and the five matrix sizes, diffed against `baselines/v1.2.1/computed/`. How the two captures');
    out.push('are held to one measurement, what is normalised before anything counts as a difference, and why the');
    out.push('geometry properties are reported rather than gated: `tools/baseline/diff-computed.mjs`.');
    out.push('');
    out.push('| | Count |');
    out.push('|---|---|');
    out.push('| Design-property differences, settled with a reason | ' + settled.length + ' |');
    out.push('| Design-property differences, **unexplained** | ' + unexplained.length + ' |');
    out.push('| Geometry-property differences (reported, not a gate) | ' + geometry + ' |');
    out.push('');
    out.push(unexplained.length === 0
        ? 'Every surviving difference carries a reason. Nothing is unaccounted for.'
        : '**' + unexplained.length + ' difference(s) carry no reason. Each is a defect until it is either fixed ' +
          'or entered in the register with one.**');
    out.push('');

    if (unexplained.length > 0) {
        out.push('## Unexplained - these are defects');
        out.push('');
        out.push('| Page | Property | Rendered by | Value |');
        out.push('|---|---|---|---|');
        for (const d of unexplained) {
            out.push('| `' + d.page + '` | `' + d.prop + '` | ' + by(d.side) + ' | `' + d.value + '` |');
        }
        out.push('');
    }

    out.push('## Settled, with the reason for each');
    out.push('');
    out.push('| Page | Property | Rendered by | Value | Why this stands |');
    out.push('|---|---|---|---|---|');
    for (const d of settled) {
        out.push('| `' + d.page + '` | `' + d.prop + '` | ' + by(d.side) + ' | `' + d.value + '` | ' + d.why + ' |');
    }
    out.push('');
    out.push('## Geometry, per page');
    out.push('');
    out.push('| Page | Differing values |');
    out.push('|---|---|');
    for (const page of PAGES) {
        out.push('| `' + page + '` | ' + result.geometry[page].unexplained.length + ' |');
    }
    out.push('');
    out.push('The DOM differs by construction - v1.2.1 carried every modal in its markup and v2 mounts one when it');
    out.push('opens - and the content column is 40rem where the v1.2.1 column was 448px (owner, 2026-09-14), so');
    out.push('above 448px these baselines have nothing left to match. A geometry difference here is evidence of');
    out.push('neither parity nor its absence, which is why it is counted rather than gated.');
    return out.join(NEWLINE) + NEWLINE;
}

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const argv = process.argv.slice(2);
    const v2Arg = argv.find((a) => a.startsWith('--v2='));
    const reportArg = argv.find((a) => a.startsWith('--report='));

    let result;
    try {
        result = run({ v2Dir: v2Arg ? path.resolve(v2Arg.slice('--v2='.length)) : undefined });
    } catch (error) {
        console.error(SCRIPT_NAME + ': ' + error.message);
        process.exit(2);
    }

    const report = renderReport(result);
    if (reportArg) {
        const file = path.resolve(reportArg.slice('--report='.length));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, report);
        console.log(SCRIPT_NAME + ': wrote ' + file);
    } else {
        process.stdout.write(report);
    }

    const remaining = PAGES.reduce((sum, page) => sum + result.design[page].unexplained.length, 0);
    process.exit(remaining === 0 ? 0 : 1);
}

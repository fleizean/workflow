/*
 * The colour maths and the register behind criterion 2's second gate.
 *
 * 08-REVIEW-TIMER WR-07 / 08-REVIEW-SCREENS WR-05: neither capture-v2.mjs nor diff-computed.mjs was referenced by
 * any package.json script, any test or any workflow. diff-computed's own header argues that its SETTLED register
 * is "a gate rather than a reading: a future change either matches the baselines or arrives in the unexplained
 * list", and PARITY-CHECKLIST.md describes the tool as one that "exits non-zero on any difference that is not in
 * its register with a reason" - but nothing ran it, so it exited non-zero at nobody, and the committed
 * 29-difference register could not go stale in a way any check would notice. Not one of the ~200 lines of colour
 * maths that decide what COUNTS as a difference was exercised either.
 *
 * `npm run parity:check` is the gate itself, and it needs a packaged build. This is what runs in the ordinary
 * suite: the normalisation, and a staleness guard over the committed report.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers/ts-imports';

import {
    PAGES, SETTLED, colourToHex, normalise, oklabToSrgb, settledReason, splitTopLevel
} from '../tools/baseline/diff-computed.mjs';
import { FORCED_CHILD_ENV, childEnvironment } from '../tools/baseline/probe-userdata.mjs';
import { UPDATE_CHECK_DISABLED_ENV } from '../src/main/config';

const REPORT = path.join(repoRoot, 'baselines', 'v1.2.1', 'VISUAL-PARITY-DIFF.md');
const report = fs.readFileSync(REPORT, 'utf8');

describe('the colour resolution that decides what counts as a difference', () => {
    it('reads black, white and mid grey out of oklab', () => {
        expect(oklabToSrgb(0, 0, 0)).toEqual([0, 0, 0]);
        expect(oklabToSrgb(1, 0, 0)).toEqual([255, 255, 255]);
        // An achromatic oklch is the same grey however it is spelled, which is the whole premise.
        expect(colourToHex('oklch', '1 0 0')).toBe('#ffffffff');
        expect(colourToHex('oklch', '0 0 0')).toBe('#000000ff');
        expect(colourToHex('oklab', '1 0 0')).toBe('#ffffffff');
    });

    it('spells rgb and rgba the same way, in both syntaxes', () => {
        expect(colourToHex('rgb', '16, 28, 34')).toBe('#101c22ff');
        expect(colourToHex('rgb', '16 28 34')).toBe('#101c22ff');
        expect(colourToHex('rgba', '16, 28, 34, 0.5')).toBe('#101c2280');
        expect(colourToHex('rgb', '16 28 34 / 50%')).toBe('#101c2280');
    });

    it('refuses a notation it does not understand rather than inventing a colour', () => {
        expect(colourToHex('lab', '50 20 30')).toBeNull();
        expect(normalise('color', 'lab(50 20 30)')).toBe('lab(50 20 30)');
    });

    it('resolves every colour in a declaration, not just the first', () => {
        expect(normalise('border', '1px solid rgb(255, 0, 0)')).toBe('1px solid #ff0000ff');
    });
});

describe('the normalisations the header says are not differences', () => {
    it('drops the always-transparent shadow slots v4 adds', () => {
        expect(normalise('box-shadow', 'rgba(0, 0, 0, 0) 0px 0px 0px 0px')).toBe('none');
        expect(normalise('box-shadow', 'rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(255, 0, 0) 0px 1px 2px 0px'))
            .toBe('#ff0000ff 0px 1px 2px 0px');
    });

    it('zeroes an outline width that draws nothing because the style is none', () => {
        expect(normalise('outline', 'rgb(100, 116, 139) none 0px'))
            .toBe(normalise('outline', 'rgb(100, 116, 139) none 3px'));
    });

    it('reads v3 9999px pill and v4 calc(infinity * 1px) as the same pill', () => {
        expect(normalise('border-radius', '9999px')).toBe(normalise('border-radius', '33554400px'));
        // The control: an ordinary radius is still itself.
        expect(normalise('border-radius', '8px')).not.toBe(normalise('border-radius', '9999px'));
    });

    it('splits a comma list without cutting inside a function call', () => {
        expect(splitTopLevel('rgb(0, 0, 0) 0px 1px, rgb(1, 1, 1) 0px 2px'))
            .toEqual(['rgb(0, 0, 0) 0px 1px', ' rgb(1, 1, 1) 0px 2px']);
    });
});

describe('WR-07: the committed report cannot go stale unnoticed', () => {
    it('carries every register entry, with its reason', () => {
        expect(SETTLED.length).toBeGreaterThan(0);
        for (const entry of SETTLED) {
            const row = '| `' + entry.page + '` | `' + entry.prop + '` | ' +
                (entry.side === 'v1' ? 'v1.2.1 only' : 'v2 only') + ' | `' + entry.value + '` |';
            expect(report, 'the register holds a difference the report does not name').toContain(row);
            expect(report).toContain(entry.why);
        }
    });

    it('states the number the register actually holds', () => {
        const stated = /Design-property differences, settled with a reason \| (\d+) \|/.exec(report);
        expect(stated?.[1], 'the report does not state a settled count').toBeDefined();
        expect(Number(stated?.[1]), 'the stated count and the register disagree').toBe(SETTLED.length);
    });

    it('claims nothing unexplained, which is what makes it a gate', () => {
        expect(report).toContain('| Design-property differences, **unexplained** | 0 |');
    });

    it('answers for every entry it registers, and for nothing else', () => {
        for (const entry of SETTLED) {
            expect(settledReason(entry.page, entry.prop, entry.side, entry.value)?.why).toBe(entry.why);
        }
        expect(settledReason('index', 'color', 'v2', '#000000ff')).toBeUndefined();
    });

    it('registers nothing for a page the diff does not visit', () => {
        for (const entry of SETTLED) {
            expect(PAGES).toContain(entry.page);
        }
    });

    it('has a header nobody pasted into (WR-10)', () => {
        const source = fs.readFileSync(path.join(repoRoot, 'tools', 'baseline', 'diff-computed.mjs'), 'utf8');
        const header = source.slice(0, source.indexOf('*/'));
        expect(header, 'a statement was pasted into the block comment again').not.toContain('lines.push(');
        expect(header).toContain('evidence of nothing either way');
    });
});

describe('WR-07: the gate is reachable from the command line', () => {
    const scripts = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };

    it('names the capture, the diff and the check', () => {
        expect(scripts.scripts['baseline:capture-v2']).toContain('capture-v2.mjs');
        expect(scripts.scripts['baseline:diff']).toContain('diff-computed.mjs');
        expect(scripts.scripts['parity:check']).toContain('parity-check.mjs');
    });

    it('is invoked by the workflow that has a packaged build to photograph', () => {
        const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'package.yml'), 'utf8');
        expect(workflow, 'nothing runs the parity gate').toContain('parity:check');
    });
});

/*
 * Phase 11: the gate failed three times running, on a different page and a different property each time, because
 * the answer was where the operator's mouse was. At 1920x1080 the window fills the screen, the real pointer lands
 * on whatever is under it, and Chromium applies :hover - which the vocabulary diff reads as a colour v1.2.1 never
 * had. It was caught as `oklab(0.684327 -0.0772989 -0.129777 / 0.9)` on the Settings Save button, Tailwind's
 * hover:bg-primary/90, normalising to #13a4ece6.
 */
describe('the capture does not depend on where the mouse is', () => {
    const capture = fs.readFileSync(path.join(repoRoot, 'tools', 'baseline', 'capture-v2.mjs'), 'utf8');

    it('stops the OS pointer reaching the content before any route is captured', () => {
        expect(capture, 'the capture reads hover states off whatever the pointer happens to be over')
            .toContain('setIgnoreMouseEvents(true)');
        expect(
            capture.indexOf('setIgnoreMouseEvents(true)'),
            'mouse events are disabled after the first route has already been captured'
        ).toBeLessThan(capture.indexOf('await captureRoute('));
    });

    it('would report a hover colour as a difference, which is why the line above matters', () => {
        // Not a hypothetical: this is the exact value the failing runs produced, through the real normaliser.
        expect(normalise('background-color', 'oklab(0.684327 -0.0772989 -0.129777 / 0.9)')).toBe('#13a4ece6');
        expect(settledReason('settings', 'background-color', 'v2', '#13a4ece6'),
            'a hover colour was added to the settled register instead of being kept out of the capture')
            .toBeUndefined();
    });
});

/*
 * REPO-06: a harness launches the real application, which asks GitHub for a version manifest thirty seconds
 * after its window opens - and a parity capture runs for about a minute. Every launcher takes its environment
 * from childEnvironment(), so the opt-out is set there once.
 */
describe('no harness reaches the network', () => {
    it('forces the update check off for every child process', () => {
        expect(FORCED_CHILD_ENV).toEqual({ WORKFLOW_NO_UPDATE_CHECK: '1' });
        expect(Object.keys(FORCED_CHILD_ENV)[0], 'the harness sets a variable src/main/config.ts does not read')
            .toBe(UPDATE_CHECK_DISABLED_ENV);
        expect(childEnvironment({}).env['WORKFLOW_NO_UPDATE_CHECK']).toBe('1');
        // And it wins over an ambient value, so a shell that exported an empty string cannot re-enable it.
        expect(childEnvironment({ WORKFLOW_NO_UPDATE_CHECK: '' }).env['WORKFLOW_NO_UPDATE_CHECK']).toBe('1');
    });

    it('is what a launcher actually passes to the app', () => {
        for (const tool of ['baseline/capture-v2.mjs', 'baseline/responsive-matrix.mjs', 'offline-routes.mjs',
            'upgrade-over-v121.mjs', 'second-instance.mjs', 'smoke-packaged.mjs']) {
            expect(fs.readFileSync(path.join(repoRoot, 'tools', tool), 'utf8'),
                'tools/' + tool + ' builds its own environment instead of taking childEnvironment()')
                .toContain('childEnvironment()');
        }
    });
});

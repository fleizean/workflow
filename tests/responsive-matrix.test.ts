/*
 * The judgement behind Phase 10's 15-cell matrix, and a staleness guard over what it recorded.
 *
 * `npm run matrix:check` is the gate, and it needs a packaged build to drive - so what runs in the ordinary suite
 * is the part that decides what COUNTS as a failure, exercised with negative controls. A verdict function that
 * cannot be shown to fail is a verdict function that proves nothing, and this one has to be trusted 588 times.
 *
 * The committed report is held to the shape the criterion asks for: 15 cells, none sampled, none failing.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers/ts-imports';

import {
    CELL_COUNT, MODALS_NOT_REACHED, SCALES, SIZES, judgeModal, judgeRoute
} from '../tools/baseline/responsive-matrix.mjs';

const REPORT = path.join(repoRoot, 'baselines', 'v2', 'RESPONSIVE-MATRIX.md');
const report = fs.readFileSync(REPORT, 'utf8');

const box = (left: number, right: number): Record<string, number> => ({
    left, right, top: 0, bottom: 100, width: right - left, height: 100
});

/** A cell in which everything is correct, so each control below changes exactly one thing. */
function healthy(): Record<string, unknown> {
    return {
        modalOpen: false,
        innerWidth: 380,
        innerHeight: 600,
        devicePixelRatio: 1.5,
        documentScrollWidth: 380,
        bodyScrollWidth: 380,
        shell: box(0, 380),
        nav: box(0, 380),
        dial: { ...box(90, 290), width: 200, height: 200 },
        canvas: { cssWidth: 100, cssHeight: 50, bitmapWidth: 150, bitmapHeight: 75 },
        overflowing: [], overflowingCount: 0,
        clipped: [], clippedCount: 0,
        behindNav: [], behindNavCount: 0,
        scrolled: { scrollTop: 0, scrollHeight: 600, clientHeight: 600 }
    };
}

const failedLabels = (measured: Record<string, unknown>, size: readonly number[]): string[] =>
    judgeRoute(measured, size).filter((check: { pass: boolean }) => !check.pass)
        .map((check: { label: string }) => check.label);

describe('the per-route verdict', () => {
    it('passes a cell in which nothing is wrong', () => {
        expect(failedLabels(healthy(), [380, 600])).toEqual([]);
    });

    it('fails a document wider than its viewport', () => {
        expect(failedLabels({ ...healthy(), documentScrollWidth: 381 }, [380, 600]))
            .toEqual(['the document is no wider than the viewport']);
        expect(failedLabels({ ...healthy(), bodyScrollWidth: 400 }, [380, 600]))
            .toEqual(['the document is no wider than the viewport']);
    });

    it('fails an element hanging past an edge, and names it', () => {
        const overflowing = [{ path: 'x', name: 'canvas.absolute', detail: '0.0..554.3 of 380' }];
        const checks = judgeRoute({ ...healthy(), overflowing, overflowingCount: 1 }, [380, 600]);
        const failed = checks.find((check: { pass: boolean }) => !check.pass);
        expect(failed?.label).toBe('no drawn element crosses either edge');
        // The detail is what a reader has to act on; a bare count would send them back to the app to look.
        expect(failed?.detail).toContain('canvas.absolute');
        expect(failed?.detail).toContain('554.3');
    });

    it('fails a clipped box and content left behind the bottom bar', () => {
        expect(failedLabels({ ...healthy(), clippedCount: 1, clipped: [{ path: 'x', name: 'div', detail: 'd' }] }, [380, 600]))
            .toEqual(['no overflow:hidden box cuts off what it holds']);
        expect(failedLabels({ ...healthy(), behindNavCount: 2, behindNav: [{ path: 'x', name: 'p', detail: 'd' }] }, [380, 600]))
            .toEqual(['nothing sits behind the bottom bar at the end of the scroll']);
    });

    it('fails a bottom bar that is not the width of the content column - the v1.2.1 430-vs-448 defect', () => {
        expect(failedLabels({ ...healthy(), nav: box(9, 371) }, [380, 600]))
            .toEqual(['the bottom bar is aligned with the content column']);
        // Half a pixel is device-pixel rounding at a fractional scale, not a misalignment.
        expect(failedLabels({ ...healthy(), nav: box(0.4, 380) }, [380, 600])).toEqual([]);
    });

    it('fails a ring that is not square, and one that does not fit its column', () => {
        expect(failedLabels({ ...healthy(), dial: { ...box(90, 290), width: 200, height: 260 } }, [380, 600]))
            .toEqual(['the timer ring keeps its aspect ratio']);
        expect(failedLabels({ ...healthy(), dial: { ...box(0, 500), width: 500, height: 500 } }, [380, 600]))
            .toEqual(['the timer ring fits the column']);
    });

    it('fails a canvas whose bitmap ignores the device pixel ratio - the soft-flame defect', () => {
        // The shape the component had before Phase 10: a 300x150 bitmap whatever the box or the scale.
        expect(failedLabels({
            ...healthy(),
            canvas: { cssWidth: 100, cssHeight: 50, bitmapWidth: 300, bitmapHeight: 150 }
        }, [380, 600])).toEqual(['the fire canvas bitmap is sized in device pixels']);
    });

    it('fails a viewport smaller than the cell asks for, and allows the two pixels Windows adds at 125%', () => {
        // A 379px viewport also makes the 380px document too wide for it, which is the point: a cell that came out
        // narrower than it claims is measuring a layout nobody asked it to measure.
        expect(failedLabels({ ...healthy(), innerWidth: 379 }, [380, 600])).toEqual([
            'the window reached at least 380x600 CSS px, and no more than 4 over',
            'the document is no wider than the viewport'
        ]);
        expect(failedLabels({ ...healthy(), innerWidth: 382, innerHeight: 602 }, [380, 600])).toEqual([]);
        expect(failedLabels({ ...healthy(), innerWidth: 420 }, [380, 600]))
            .toEqual(['the window reached at least 380x600 CSS px, and no more than 4 over']);
    });

    it('fails a cell measured with a dialog over it, so a contaminated profile cannot read as a layout bug', () => {
        expect(failedLabels({ ...healthy(), modalOpen: true }, [380, 600]))
            .toEqual(['the route was measured with nothing over it']);
    });

    it('skips the ring and the canvas on a route that has neither, rather than inventing a verdict', () => {
        const checks = judgeRoute({ ...healthy(), dial: null, canvas: null }, [380, 600]);
        expect(checks.map((check: { label: string }) => check.label).join(' ')).not.toContain('ring');
        expect(checks.every((check: { pass: boolean }) => check.pass)).toBe(true);
    });
});

describe('the per-modal verdict', () => {
    const fits = {
        found: true,
        panel: { left: 16, right: 364, top: 24, bottom: 576, width: 348, height: 552 },
        overlay: { left: 0, right: 380, top: 0, bottom: 600 },
        body: { overflowY: 'auto', scrollHeight: 900, clientHeight: 420, scrollbarWidth: 'none' },
        fits: true,
        innerWidth: 380,
        innerHeight: 600
    };
    const failed = (measured: unknown): string[] =>
        judgeModal('Dialog', measured).filter((c: { pass: boolean }) => !c.pass).map((c: { label: string }) => c.label);

    it('passes a dialog that fits and scrolls inside itself', () => {
        expect(failed(fits)).toEqual([]);
    });

    it('reports a dialog that never opened, and says nothing else about it', () => {
        expect(judgeModal('Dialog', { found: false })).toHaveLength(1);
        expect(failed({ found: false })).toEqual(['Dialog: the dialog opened']);
    });

    it('fails a panel taller than the window - criterion 3 at a 600px height', () => {
        expect(failed({ ...fits, fits: false, panel: { ...fits.panel, bottom: 720, height: 700 } }))
            .toEqual(['Dialog: the panel is inside the viewport']);
    });

    it('fails a panel with no internal scroll box, and one that draws a raw scrollbar', () => {
        expect(failed({ ...fits, body: null })).toEqual([
            'Dialog: it scrolls inside itself rather than overflowing',
            'Dialog: the scrollbar stays hidden, as every v1.2.1 overlay did'
        ]);
        expect(failed({ ...fits, body: { ...fits.body, scrollbarWidth: 'auto' } }))
            .toEqual(['Dialog: the scrollbar stays hidden, as every v1.2.1 overlay did']);
    });
});

describe('the committed matrix report', () => {
    it('is fifteen cells, because the criterion says checked and recorded, not sampled', () => {
        expect(CELL_COUNT).toBe(15);
        expect(SCALES).toEqual([1, 1.25, 1.5]);
        expect(report).toContain('| Cells measured | 15 of 15 |');
        for (const [width, height] of SIZES) {
            for (const scale of SCALES) {
                const row = '| ' + String(width) + 'x' + String(height) + ' | ' + String(Math.round(scale * 100)) + '% |';
                expect(report, row + ' is missing from the report').toContain(row);
            }
        }
    });

    it('records no failure, no remote request and no CSP violation', () => {
        expect(report).toContain('| Checks failed | **0** |');
        expect(report).toContain('| Remote requests attempted | 0 |');
        expect(report).toContain('| CSP violations reported | 0 |');
    });

    it('names the dialogs the harness cannot reach, rather than leaving them out', () => {
        expect(MODALS_NOT_REACHED.length).toBeGreaterThan(0);
        for (const [name] of MODALS_NOT_REACHED) {
            expect(report, name + ' is not declared unreached').toContain('| ' + name + ' |');
        }
    });

    it('proves the fire canvas loop stopped at every scale, which is the leak criterion 4 names', () => {
        const stopped = report.match(/cancels its frame loop on unmount \| `0 frame\(s\) after leaving Home/g) ?? [];
        expect(stopped).toHaveLength(SCALES.length);
        // The control beside it: a loop that was never running could not be proved to have stopped.
        const running = report.match(/really was animating before the unmount/g) ?? [];
        expect(running).toHaveLength(SCALES.length);
    });
});

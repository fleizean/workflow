// Criterion 9: the window cannot be resized below its minimum, and its size and position come back only onto a
// display that exists now. The arithmetic is Electron-free, so an unplugged monitor is a test case rather than a
// hardware requirement - which is the whole reason this decision was not left inline in the BrowserWindow options.

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
    MIN_VISIBLE_HEIGHT, MIN_VISIBLE_WIDTH, atLeastMinimum, chooseWindowBounds, isOnAnyDisplay, visibleArea
} from '../src/main/window-bounds';
import { MAIN_WINDOW } from '../src/main/config';
import { APP_STATE_KEYS, WindowBoundsRecordSchema } from '../src/lib/db/app-state';
import { findAll, read } from './helpers/ts-imports';
import type { DisplayArea, WindowBounds } from '../src/main/window-bounds';

const WINDOW_FILE = 'src/main/window.ts';
const MINIMUM = { width: MAIN_WINDOW.minWidth, height: MAIN_WINDOW.minHeight };
const DEFAULT_SIZE = { width: MAIN_WINDOW.width, height: MAIN_WINDOW.height };

const display = (x: number, y: number, width: number, height: number): DisplayArea =>
    ({ workArea: { x, y, width, height } });

// A laptop screen with a second monitor to its left, which is where negative coordinates come from.
const LAPTOP = display(0, 0, 1920, 1040);
const LEFT_MONITOR = display(-1920, -200, 1920, 1080);

const at = (x: number, y: number): WindowBounds => ({ x, y, width: 430, height: 932 });

describe('criterion 9: a saved position is restored only onto a display that exists', () => {
    it('restores a window that sits squarely on the laptop screen', () => {
        const chosen = chooseWindowBounds(at(200, 100), [LAPTOP], DEFAULT_SIZE, MINIMUM);
        expect(chosen).toEqual({ size: { width: 430, height: 932 }, position: { x: 200, y: 100 }, origin: 'restored' });
    });

    it('restores one on a second monitor while that monitor is still there', () => {
        expect(chooseWindowBounds(at(-1800, -100), [LAPTOP, LEFT_MONITOR], DEFAULT_SIZE, MINIMUM).origin)
            .toBe('restored');
    });

    it('falls back to the default when that monitor has been unplugged', () => {
        const chosen = chooseWindowBounds(at(-1800, -100), [LAPTOP], DEFAULT_SIZE, MINIMUM);
        expect(chosen.origin).toBe('default-off-screen');
        expect(chosen.position, 'a default opening is Electron\'s to place, centred on the primary display').toBeNull();
        expect(chosen.size).toEqual(DEFAULT_SIZE);
    });

    it('falls back when the screen shrank under a window that used to fit', () => {
        // 2560-wide monitor replaced by a 1280-wide one; the window was parked at x=2000.
        expect(chooseWindowBounds(at(2000, 40), [display(0, 0, 1280, 1000)], DEFAULT_SIZE, MINIMUM).origin)
            .toBe('default-off-screen');
    });

    it('keeps a window that hangs off an edge but is still usable', () => {
        // Half off the right edge: the title bar is still reachable, so this is where the user left it.
        expect(chooseWindowBounds(at(1700, 10), [LAPTOP], DEFAULT_SIZE, MINIMUM).origin).toBe('restored');
    });

    it('refuses one that is on screen by a sliver nobody could grab', () => {
        expect(chooseWindowBounds(at(1920 - MIN_VISIBLE_WIDTH + 1, 10), [LAPTOP], DEFAULT_SIZE, MINIMUM).origin)
            .toBe('default-off-screen');
        expect(chooseWindowBounds(at(10, 1040 - MIN_VISIBLE_HEIGHT + 1), [LAPTOP], DEFAULT_SIZE, MINIMUM).origin)
            .toBe('default-off-screen');
    });

    it('opens at the default with nothing saved, and with a value no schema would have written', () => {
        expect(chooseWindowBounds(null, [LAPTOP], DEFAULT_SIZE, MINIMUM).origin).toBe('default-no-saved-bounds');
        const broken: WindowBounds[] = [
            { x: 0, y: 0, width: 0, height: 600 },
            { x: 0, y: 0, width: 430, height: -1 },
            { x: Number.NaN, y: 0, width: 430, height: 932 },
            { x: 0, y: 0, width: 430.5, height: 932 }
        ];
        for (const bounds of broken) {
            expect(chooseWindowBounds(bounds, [LAPTOP], DEFAULT_SIZE, MINIMUM).origin,
                JSON.stringify(bounds) + ' was treated as a position').toBe('default-no-saved-bounds');
        }
    });

    it('opens at the default when the machine reports no display at all', () => {
        expect(chooseWindowBounds(at(200, 100), [], DEFAULT_SIZE, MINIMUM).origin).toBe('default-off-screen');
    });

    /*
     * WR-04. chooseWindowBounds raised a stored size to the minimum and never capped it, and persistBoundsOn skips
     * only a hidden or minimised window - a maximised one is visible, so its rectangle is what gets saved. Maximise
     * on a 3840x2160 monitor, close, unplug, relaunch on a 1920x1080 laptop: the overlap test was satisfied and the
     * window came back frameless at 3840x2160, with both resize edges off the screen and no title bar to grab.
     */
    it('caps a size saved on a larger monitor to the display it comes back on', () => {
        const chosen = chooseWindowBounds({ x: 0, y: 0, width: 3840, height: 2160 }, [LAPTOP], DEFAULT_SIZE, MINIMUM);
        expect(chosen.origin).toBe('restored');
        expect(chosen.size, 'the window came back larger than the screen').toEqual({ width: 1920, height: 1040 });
        expect(chosen.position).toEqual({ x: 0, y: 0 });
    });

    it('pulls the window back onto the display when the cap took it off the screen', () => {
        // Mostly on a monitor to the left that has been unplugged: 190 px of it lands on the laptop, which is enough
        // to restore - but capping the width to the laptop leaves only 110, which is not.
        const chosen = chooseWindowBounds({ x: -1810, y: 10, width: 2000, height: 900 }, [LAPTOP], DEFAULT_SIZE, MINIMUM);
        expect(chosen.origin).toBe('restored');
        expect(chosen.size).toEqual({ width: 1920, height: 900 });
        expect(chosen.position).toEqual({ x: 0, y: 10 });
    });

    it('leaves a window the user parked half off an edge exactly where it was', () => {
        // The cap changes nothing here, so neither does the position: this is criterion 9's "where the user left it".
        expect(chooseWindowBounds(at(1700, 10), [LAPTOP], DEFAULT_SIZE, MINIMUM))
            .toEqual({ size: { width: 430, height: 932 }, position: { x: 1700, y: 10 }, origin: 'restored' });
    });

    it('keeps the minimum even on a display too small for it', () => {
        const tiny = display(0, 0, 300, 400);
        const chosen = chooseWindowBounds({ x: 0, y: 0, width: 900, height: 900 }, [tiny], DEFAULT_SIZE, MINIMUM);
        expect(chosen.size, 'a screen too small for the minimum is one the app cannot be used on either way')
            .toEqual(MINIMUM);
    });

    /*
     * IN-02. Selection was by raw overlap area, so a 2000x30 strip and a 150x400 landing scored the same and the
     * first display listed won. If the thin one was first the result failed the minimum-visible test and the window
     * opened at the default, even though a position the user could reach existed on the other screen.
     */
    it('prefers a landing the user could reach over a wider one they could not', () => {
        // A wide, short strip of the first display and a narrow, tall piece of the second: 2000x30 against 150x400.
        const strip = display(0, 0, 4000, 30);
        const reachable = display(0, 100, 150, 900);
        const saved = { x: 0, y: 0, width: 2000, height: 500 };

        expect(visibleArea(saved, [strip, reachable]))
            .toEqual({ width: 150, height: 400 });
        expect(chooseWindowBounds(saved, [strip, reachable], DEFAULT_SIZE, MINIMUM).origin,
            'the window opened at the default with a usable position going spare').toBe('restored');
    });

    it('does not add two half-overlaps into one usable window', () => {
        // A gap between two monitors: the window straddles it and is mostly in the void.
        const left = display(0, 0, 1000, 1000);
        const right = display(1400, 0, 1000, 1000);
        expect(visibleArea({ x: 950, y: 0, width: 500, height: 900 }, [left, right]).width).toBe(50);
        expect(isOnAnyDisplay({ x: 950, y: 0, width: 500, height: 900 }, [left, right])).toBe(false);
    });
});

describe('criterion 9: the minimum size', () => {
    it('is the one the window is built with, and the one a restored size is raised to', () => {
        expect(atLeastMinimum({ width: 100, height: 100 }, MINIMUM)).toEqual(MINIMUM);
        const chosen = chooseWindowBounds(
            { x: 10, y: 10, width: 200, height: 300 }, [LAPTOP], DEFAULT_SIZE, MINIMUM);
        expect(chosen.size, 'a window saved below the minimum came back below it').toEqual(MINIMUM);
        expect(chosen.origin).toBe('restored');
    });

    it('leaves a size that is already large enough alone', () => {
        expect(atLeastMinimum({ width: 800, height: 700 }, MINIMUM)).toEqual({ width: 800, height: 700 });
    });

    it('is passed to BrowserWindow, so Electron refuses the drag itself', () => {
        const source = ts.createSourceFile(WINDOW_FILE, read(WINDOW_FILE), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const [construction] = findAll(source, (node): node is ts.NewExpression =>
            ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'BrowserWindow');
        const options = construction?.arguments?.[0];
        expect(options !== undefined && ts.isObjectLiteralExpression(options)).toBe(true);
        const keys = options !== undefined && ts.isObjectLiteralExpression(options)
            ? options.properties.flatMap((property) =>
                ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) ? [property.name.text] : [])
            : [];
        expect(keys, WINDOW_FILE + ': the window is built without a minimum size')
            .toEqual(expect.arrayContaining(['minWidth', 'minHeight']));
    });

    it('is the size Phase 10\'s responsive matrix starts at', () => {
        expect(MINIMUM).toEqual({ width: 380, height: 600 });
    });
});

describe('IPC-05: the bounds live in the database, not in a file beside it', () => {
    it('has its own app_state key and a strict schema', () => {
        expect(APP_STATE_KEYS.windowBounds).toBe('window.bounds');
        const valid = { x: -1800, y: -100, width: 430, height: 932, updatedAt: '2026-09-13T00:00:00.000Z' };
        expect(WindowBoundsRecordSchema.safeParse(valid).success, 'a second monitor has negative coordinates')
            .toBe(true);
        for (const broken of [
            { ...valid, width: 0 },
            { ...valid, height: -1 },
            { ...valid, x: 1.5 },
            { ...valid, maximised: true }
        ]) {
            expect(WindowBoundsRecordSchema.safeParse(broken).success, JSON.stringify(broken) + ' was accepted')
                .toBe(false);
        }
    });

    it('is written by no JSON file: the window module names a store, never a path', () => {
        const source = read(WINDOW_FILE);
        expect(source, 'the window module writes its own file somewhere').not.toContain('writeFileSync');
        expect(source).not.toContain('bounds.json');
        expect(source, 'the window module must reach the database only through the injected store')
            .not.toContain('@lib/db');
    });
});

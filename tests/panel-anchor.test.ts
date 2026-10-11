/*
 * PANEL-01's arithmetic, driven against controlled display lists rather than against a screen.
 *
 * The claim is narrow and it is the whole requirement: the panel opens on the display the tray icon is on, clear of
 * the taskbar, and inside that display's work area - at every taskbar position, on every display in a multi-display
 * arrangement, and when the platform reports no icon rectangle at all. The last case is Linux, where Tray.getBounds
 * returns zeroes and a naive anchor puts the panel at 0,0 on the primary display.
 */

import { describe, expect, it } from 'vitest';
import {
    anchorPanel, decidePanelBlur, decidePanelClick, displayNearestPoint, fallbackTrayBounds, isPanelVisible,
    trayEdgeOf
} from '../src/main/panel-anchor';
import { PANEL_GAP, PANEL_REOPEN_GUARD_MS, PANEL_WINDOW } from '../src/main/config';
import type { DisplayArea, WindowBounds } from '../src/main/window-bounds';

const SIZE = { width: PANEL_WINDOW.width, height: PANEL_WINDOW.height };
const display = (workArea: WindowBounds): DisplayArea => ({ workArea });

/** 1920x1080 with a 40px taskbar at the bottom, which is what the verified target looks like. */
const PRIMARY = display({ x: 0, y: 0, width: 1920, height: 1040 });
/** A second monitor to the left and above, so a negative origin is covered rather than assumed away. */
const LEFT_SECOND = display({ x: -1280, y: -200, width: 1280, height: 800 });
/** A short display, so the vertical clamp has something to bite on: 388px of panel into 360px of work area. */
const SHORT = display({ x: 0, y: 0, width: 1024, height: 360 });

/** The 16x16 notification-area icon, parked on the taskbar below the work area. */
const bottomTrayIcon = (centreX: number): WindowBounds => ({ x: centreX - 8, y: 1048, width: 16, height: 16 });

const inside = (bounds: WindowBounds, workArea: WindowBounds): boolean =>
    bounds.x >= workArea.x && bounds.y >= workArea.y &&
    bounds.x + bounds.width <= workArea.x + workArea.width &&
    bounds.y + bounds.height <= workArea.y + workArea.height;

const anchor = (tray: WindowBounds | null, displays: readonly DisplayArea[], platform = 'win32') =>
    anchorPanel({ tray, size: SIZE, displays, gap: PANEL_GAP, platform });

describe('PANEL-01: the edge the tray icon is parked on', () => {
    it('reads a bottom taskbar from an icon below the work area', () => {
        expect(trayEdgeOf(bottomTrayIcon(1800), PRIMARY.workArea)).toBe('bottom');
    });

    it('reads a macOS menu bar from an icon above the work area', () => {
        // The menu bar is 25px tall and the work area starts under it.
        const menuBar = display({ x: 0, y: 25, width: 1440, height: 875 });
        expect(trayEdgeOf({ x: 1300, y: 2, width: 20, height: 22 }, menuBar.workArea)).toBe('top');
    });

    it('reads a taskbar docked to the left and to the right', () => {
        const leftDocked = display({ x: 62, y: 0, width: 1858, height: 1080 });
        expect(trayEdgeOf({ x: 20, y: 1000, width: 16, height: 16 }, leftDocked.workArea)).toBe('left');
        const rightDocked = display({ x: 0, y: 0, width: 1858, height: 1080 });
        expect(trayEdgeOf({ x: 1890, y: 1000, width: 16, height: 16 }, rightDocked.workArea)).toBe('right');
    });

    it('prefers a horizontal edge on a tie, because a taskbar is horizontal unless it was moved', () => {
        // Dead centre of a square work area: all four distances are equal.
        const square = display({ x: 0, y: 0, width: 1000, height: 1000 });
        expect(trayEdgeOf({ x: 492, y: 492, width: 16, height: 16 }, square.workArea)).toBe('bottom');
    });
});

describe('PANEL-01: the panel opens clear of the taskbar and inside the work area', () => {
    it('sits above a bottom taskbar, centred on the icon', () => {
        // Centred at 1000, far enough from either side that the clamp has nothing to do.
        const tray = bottomTrayIcon(1000);
        const anchored = anchor(tray, [PRIMARY]);
        expect(anchored?.edge).toBe('bottom');
        expect(anchored?.bounds).toEqual({
            x: 1000 - SIZE.width / 2,
            y: tray.y - PANEL_GAP - SIZE.height,
            width: SIZE.width,
            height: SIZE.height
        });
        expect((anchored?.bounds.y ?? 0) + SIZE.height, 'the panel overlapped the taskbar it is anchored to')
            .toBeLessThan(tray.y);
    });

    it('is pushed back from the right edge rather than centred past it', () => {
        // An icon centred at 1800 would put the panel at x=1640, which ends 40px past the display.
        expect(anchor(bottomTrayIcon(1800), [PRIMARY])?.bounds.x).toBe(1920 - SIZE.width);
    });

    it('hangs off neither side when the icon is in the far corner', () => {
        for (const centreX of [4, 1916]) {
            const anchored = anchor(bottomTrayIcon(centreX), [PRIMARY]);
            expect(anchored, 'no anchor at all for an icon at x=' + String(centreX)).toBeDefined();
            expect(
                inside(anchored?.bounds as WindowBounds, PRIMARY.workArea),
                'the panel left the work area for an icon centred at x=' + String(centreX) + ': ' +
                JSON.stringify(anchored?.bounds)
            ).toBe(true);
        }
        // The left corner is clamped to the work area origin, not to a negative x.
        expect(anchor(bottomTrayIcon(4), [PRIMARY])?.bounds.x).toBe(0);
        expect(anchor(bottomTrayIcon(1916), [PRIMARY])?.bounds.x).toBe(1920 - SIZE.width);
    });

    it('hangs below a macOS menu bar rather than above it', () => {
        const menuBar = display({ x: 0, y: 25, width: 1440, height: 875 });
        const anchored = anchor({ x: 1300, y: 2, width: 20, height: 22 }, [menuBar], 'darwin');
        expect(anchored?.edge).toBe('top');
        expect(anchored?.bounds.y, 'the panel was drawn over the menu bar it hangs from').toBe(2 + 22 + PANEL_GAP);
    });

    it('shrinks to a work area shorter than itself instead of running off the bottom of it', () => {
        const anchored = anchor({ x: 900, y: 364, width: 16, height: 16 }, [SHORT]);
        expect(anchored?.bounds.height, 'the panel stayed taller than the display it opened on').toBe(360);
        expect(inside(anchored?.bounds as WindowBounds, SHORT.workArea)).toBe(true);
    });
});

describe('PANEL-01: the display the icon is on, not the primary one', () => {
    it('opens on the second monitor when the icon is on the second monitor', () => {
        const displays = [PRIMARY, LEFT_SECOND];
        // A taskbar on the second monitor, below its work area, which starts at a negative origin.
        const anchored = anchor({ x: -400, y: 608, width: 16, height: 16 }, displays);
        expect(anchored?.display).toBe(LEFT_SECOND);
        expect(inside(anchored?.bounds as WindowBounds, LEFT_SECOND.workArea)).toBe(true);
        expect(anchored?.bounds.x, 'the panel opened on the primary display instead').toBeLessThan(0);
    });

    it('opens on the primary one when the icon is there, with the same list', () => {
        const anchored = anchor(bottomTrayIcon(1800), [PRIMARY, LEFT_SECOND]);
        expect(anchored?.display).toBe(PRIMARY);
        expect(inside(anchored?.bounds as WindowBounds, PRIMARY.workArea)).toBe(true);
    });

    it('lands on a display in every one of a 12-cell matrix of icon positions and arrangements', () => {
        const arrangements: [string, DisplayArea[]][] = [
            ['one display', [PRIMARY]],
            ['two, the second left and above', [PRIMARY, LEFT_SECOND]],
            ['two, listed the other way round', [LEFT_SECOND, PRIMARY]]
        ];
        const icons: [string, WindowBounds][] = [
            ['bottom left of the primary', bottomTrayIcon(4)],
            ['bottom right of the primary', bottomTrayIcon(1916)],
            ['bottom right of the second', { x: -20, y: 608, width: 16, height: 16 }],
            ['top left of the second', { x: -1278, y: -198, width: 16, height: 16 }]
        ];
        const failures: string[] = [];
        for (const [arrangement, displays] of arrangements) {
            for (const [where, tray] of icons) {
                const anchored = anchor(tray, displays);
                const ok = anchored !== undefined &&
                    isPanelVisible(anchored.bounds, displays) &&
                    inside(anchored.bounds, anchored.display.workArea);
                if (!ok) {
                    failures.push(arrangement + ' / ' + where + ': ' + JSON.stringify(anchored?.bounds));
                }
            }
        }
        expect(failures, 'the panel opened somewhere nobody could see it').toEqual([]);
    });

    it('has nowhere to open when the screen module reports no display, and says so', () => {
        expect(anchor(bottomTrayIcon(1800), [])).toBeUndefined();
    });

    it('picks nothing from an empty display list and the containing display from a point inside one', () => {
        expect(displayNearestPoint({ x: 0, y: 0 }, [])).toBeUndefined();
        expect(displayNearestPoint({ x: 10, y: 10 }, [PRIMARY, LEFT_SECOND])).toBe(PRIMARY);
        expect(displayNearestPoint({ x: -10, y: -10 }, [PRIMARY, LEFT_SECOND])).toBe(LEFT_SECOND);
    });
});

/*
 * The Linux case, and the reason the fallback is not "the primary display at 0,0": Tray.getBounds is documented as
 * macOS and Windows only, and on Linux it answers a rectangle of zeroes. Zeroes name a real point - the top-left
 * corner - so without this the panel would open in the corner of whichever display holds the origin.
 */
describe('PANEL-01: a platform that reports no icon rectangle', () => {
    it('anchors to the trailing corner of the work area rather than to 0,0', () => {
        const anchored = anchor({ x: 0, y: 0, width: 0, height: 0 }, [PRIMARY]);
        expect(anchored?.edge).toBe('bottom');
        expect(anchored?.bounds.x, 'an unreported icon put the panel in the top-left corner')
            .toBe(1920 - SIZE.width);
        expect(anchored?.bounds.y, 'the panel was not lifted clear of the corner').toBe(1039 - PANEL_GAP - SIZE.height);
        expect(inside(anchored?.bounds as WindowBounds, PRIMARY.workArea)).toBe(true);
    });

    it('treats a null rectangle the same way, and hangs from the menu bar on darwin', () => {
        expect(anchor(null, [PRIMARY])?.bounds).toEqual(anchor({ x: 0, y: 0, width: 0, height: 0 }, [PRIMARY])?.bounds);
        expect(anchor(null, [PRIMARY], 'darwin')?.edge).toBe('top');
        expect(anchor(null, [PRIMARY], 'darwin')?.bounds.y).toBe(1 + PANEL_GAP);
    });

    it('builds the fallback rectangle at the corner the edge names', () => {
        expect(fallbackTrayBounds(PRIMARY.workArea, 'bottom')).toEqual({ x: 1919, y: 1039, width: 1, height: 1 });
        expect(fallbackTrayBounds(PRIMARY.workArea, 'top')).toEqual({ x: 1919, y: 0, width: 1, height: 1 });
    });
});

/*
 * The toggle, which is the decision the click handler makes and the one place a real bug lives: Windows raises the
 * panel's blur BEFORE the click that caused it, so the panel is already closed by the time the handler runs.
 */
describe('PANEL-01: what a tray click means', () => {
    const guardMs = PANEL_REOPEN_GUARD_MS;

    it('opens the panel when there is none and nothing just closed', () => {
        expect(decidePanelClick({ open: false, sinceBlurCloseMs: null, guardMs })).toBe('open');
        expect(decidePanelClick({ open: false, sinceBlurCloseMs: guardMs, guardMs })).toBe('open');
        expect(decidePanelClick({ open: false, sinceBlurCloseMs: 9000, guardMs })).toBe('open');
    });

    it('closes an open one', () => {
        expect(decidePanelClick({ open: true, sinceBlurCloseMs: null, guardMs })).toBe('close');
        expect(decidePanelClick({ open: true, sinceBlurCloseMs: 5, guardMs })).toBe('close');
    });

    it('ignores the click that closed the panel a moment ago, so the icon can put it away', () => {
        expect(decidePanelClick({ open: false, sinceBlurCloseMs: 0, guardMs })).toBe('ignore');
        expect(decidePanelClick({ open: false, sinceBlurCloseMs: guardMs - 1, guardMs })).toBe('ignore');
    });

    it('is not fooled by a clock that went backwards', () => {
        expect(decidePanelClick({ open: false, sinceBlurCloseMs: -50, guardMs })).toBe('open');
    });

    it('closes on blur once the panel has been shown, and not before', () => {
        expect(decidePanelBlur({ shown: true })).toBe('close');
        expect(decidePanelBlur({ shown: false }), 'a blur before the first show closed the panel on top of itself')
            .toBe('keep');
    });
});

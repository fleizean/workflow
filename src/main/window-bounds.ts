// IPC-05 / criterion 9: where the window opens, decided as arithmetic so it can be tested without a screen.
// Electron-free on purpose - window.ts passes in what Electron reported, and a test passes in a monitor that was
// unplugged between two launches.

export interface WindowBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface WindowSize {
    readonly width: number;
    readonly height: number;
}

/** What Electron's screen module reports per display. Only the work area matters: the taskbar is not usable space. */
export interface DisplayArea {
    readonly workArea: WindowBounds;
}

/*
 * How much of the window has to land on a display for the position to be worth restoring. A title bar the user can
 * reach is the whole point, so the height is small and the width is not: a window 20 px onto the screen is a window
 * nobody can grab, and the app would look as if it had failed to open.
 */
export const MIN_VISIBLE_WIDTH = 120;
export const MIN_VISIBLE_HEIGHT = 40;

export type BoundsOrigin = 'restored' | 'default-no-saved-bounds' | 'default-off-screen';

export interface ChosenBounds {
    readonly size: WindowSize;
    /** null means: let Electron place the window, which centres it on the primary display. */
    readonly position: { readonly x: number; readonly y: number } | null;
    readonly origin: BoundsOrigin;
}

const overlap = (aStart: number, aLength: number, bStart: number, bLength: number): number =>
    Math.max(0, Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart));

interface Landing {
    readonly display: DisplayArea | undefined;
    readonly size: WindowSize;
}

/*
 * IN-02: ranked by how much of the overlap is usable rather than by its raw area. A 2000x30 sliver and a 150x400
 * landing have the same area, so on the wrong display order the sliver won and the window fell back to the default
 * even though a usable position existed. Capping each side at the minimum makes any usable landing outrank any
 * unusable one; the size reported is still the real overlap.
 */
const usableArea = (width: number, height: number): number =>
    Math.min(width, MIN_VISIBLE_WIDTH) * Math.min(height, MIN_VISIBLE_HEIGHT);

/** The one display the window shares the most with. Two half-overlaps do not add up to a usable window. */
function largestOverlap(bounds: WindowBounds, displays: readonly DisplayArea[]): Landing {
    let display: DisplayArea | undefined;
    let width = 0;
    let height = 0;
    for (const area of displays) {
        const w = overlap(bounds.x, bounds.width, area.workArea.x, area.workArea.width);
        const h = overlap(bounds.y, bounds.height, area.workArea.y, area.workArea.height);
        if (usableArea(w, h) > usableArea(width, height)) {
            display = area;
            width = w;
            height = h;
        }
    }
    return { display, size: { width, height } };
}

/** The largest rectangle the window shares with any one display. */
export function visibleArea(bounds: WindowBounds, displays: readonly DisplayArea[]): WindowSize {
    return largestOverlap(bounds, displays).size;
}

/** The display a window would be restored onto, or undefined when not enough of it would land on any. */
export function displayUnder(bounds: WindowBounds, displays: readonly DisplayArea[]): DisplayArea | undefined {
    const { display, size } = largestOverlap(bounds, displays);
    return size.width >= MIN_VISIBLE_WIDTH && size.height >= MIN_VISIBLE_HEIGHT ? display : undefined;
}

/** Whether enough of the window would land on a display that currently exists. */
export function isOnAnyDisplay(bounds: WindowBounds, displays: readonly DisplayArea[]): boolean {
    const visible = visibleArea(bounds, displays);
    return visible.width >= MIN_VISIBLE_WIDTH && visible.height >= MIN_VISIBLE_HEIGHT;
}

/** A size no smaller than the minimum, whatever was stored - including by a hand-edited or truncated value. */
export function atLeastMinimum(size: WindowSize, minimum: WindowSize): WindowSize {
    return {
        width: Math.max(minimum.width, Math.round(size.width)),
        height: Math.max(minimum.height, Math.round(size.height))
    };
}

/*
 * WR-04: a size no larger than the display it is coming back onto. persistBoundsOn saves a maximised window's
 * rectangle, so a user who maximised on a 3840x2160 monitor and relaunched on a 1920x1080 laptop got a frameless
 * window bigger than the screen: both resize edges off it, and no title bar to double-click. The minimum still wins
 * over the display - a screen too small for the minimum is one the app cannot be used on either way - and the
 * position is left where the user put it unless shrinking the window took it off the screen.
 */
export function withinWorkArea(
    bounds: WindowBounds,
    workArea: WindowBounds,
    minimum: WindowSize,
    displays: readonly DisplayArea[]
): WindowBounds {
    const width = Math.max(minimum.width, Math.min(bounds.width, workArea.width));
    const height = Math.max(minimum.height, Math.min(bounds.height, workArea.height));
    const shrunk = { x: bounds.x, y: bounds.y, width, height };
    if (isOnAnyDisplay(shrunk, displays)) {
        return shrunk;
    }
    // Back onto the display it landed on, but never past that display's own origin: a window wider than the work
    // area, because the minimum is wider, stays at the top-left rather than being pushed off the other side.
    return {
        width,
        height,
        x: Math.min(Math.max(bounds.x, workArea.x), Math.max(workArea.x, workArea.x + workArea.width - width)),
        y: Math.min(Math.max(bounds.y, workArea.y), Math.max(workArea.y, workArea.y + workArea.height - height))
    };
}

const isWhole = (value: unknown): value is number => Number.isSafeInteger(value);

const usable = (bounds: WindowBounds | null): bounds is WindowBounds =>
    bounds !== null && isWhole(bounds.x) && isWhole(bounds.y) && isWhole(bounds.width) && isWhole(bounds.height) &&
    bounds.width > 0 && bounds.height > 0;

/**
 * Criterion 9: saved bounds are restored only onto a display that currently exists. A monitor unplugged between two
 * launches, or a resolution change, therefore opens the window where it can be seen rather than where it used to be.
 * The default size is the caller's; the default position is Electron's, which centres on the primary display.
 */
export function chooseWindowBounds(
    saved: WindowBounds | null,
    displays: readonly DisplayArea[],
    defaultSize: WindowSize,
    minimum: WindowSize
): ChosenBounds {
    const fallback = (origin: BoundsOrigin): ChosenBounds =>
        ({ size: atLeastMinimum(defaultSize, minimum), position: null, origin });

    if (!usable(saved)) {
        return fallback('default-no-saved-bounds');
    }
    const sized = { ...saved, ...atLeastMinimum(saved, minimum) };
    const landing = displayUnder(sized, displays);
    if (landing === undefined) {
        return fallback('default-off-screen');
    }
    const fitted = withinWorkArea(sized, landing.workArea, minimum, displays);
    return {
        size: { width: fitted.width, height: fitted.height },
        position: { x: fitted.x, y: fitted.y },
        origin: 'restored'
    };
}

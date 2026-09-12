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

/** The largest rectangle the window shares with any one display. Two half-overlaps do not add up to a usable window. */
export function visibleArea(bounds: WindowBounds, displays: readonly DisplayArea[]): WindowSize {
    let width = 0;
    let height = 0;
    for (const { workArea } of displays) {
        const w = overlap(bounds.x, bounds.width, workArea.x, workArea.width);
        const h = overlap(bounds.y, bounds.height, workArea.y, workArea.height);
        if (w * h > width * height) {
            width = w;
            height = h;
        }
    }
    return { width, height };
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
    return isOnAnyDisplay(sized, displays)
        ? { size: { width: sized.width, height: sized.height }, position: { x: sized.x, y: sized.y }, origin: 'restored' }
        : fallback('default-off-screen');
}

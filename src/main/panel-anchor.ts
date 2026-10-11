// PANEL-01: where the tray panel opens and what a tray click means, as arithmetic so both can be tested without a
// notification area. Electron-free - panel.ts passes in what the screen module reported, and a test passes in a
// display list it made up. The rectangle types and the on-screen predicate are Phase 10's (window-bounds.ts).

import { isOnAnyDisplay } from './window-bounds';
import type { DisplayArea, WindowBounds, WindowSize } from './window-bounds';

/** Which side of the work area the tray icon sits on, which is the side the panel has to open away from. */
export type TrayEdge = 'top' | 'bottom' | 'left' | 'right';

export interface AnchoredPanel {
    readonly bounds: WindowBounds;
    readonly edge: TrayEdge;
    /** The display the panel landed on - the one the icon is on, not the primary. */
    readonly display: DisplayArea;
}

const centreOf = (rect: WindowBounds): { x: number; y: number } => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2
});

/** How far a point is from a rectangle; 0 anywhere inside it. Squared, because only the ordering is used. */
function squaredDistance(point: { x: number; y: number }, rect: WindowBounds): number {
    const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
    const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
    return dx * dx + dy * dy;
}

/*
 * The display the tray icon is on. Phase 10's displayUnder cannot answer this: it requires MIN_VISIBLE_WIDTH x
 * MIN_VISIBLE_HEIGHT of overlap, and a 16x16 tray icon overlaps nothing by that much - so every icon would come back
 * as "on no display". A point is the right question for an icon, and a rectangle for a window.
 */
export function displayNearestPoint(
    point: { x: number; y: number },
    displays: readonly DisplayArea[]
): DisplayArea | undefined {
    let nearest: DisplayArea | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const display of displays) {
        const distance = squaredDistance(point, display.workArea);
        if (distance < best) {
            best = distance;
            nearest = display;
        }
    }
    return nearest;
}

/*
 * A bottom taskbar puts the icon BELOW the work area, a macOS menu bar puts it above it, and a side-docked taskbar
 * puts it beside it - so the signed distance from the icon's centre to each work-area edge is negative on exactly
 * the edge the icon is parked on, and the smallest value names it. With no taskbar at all (the icon inside the work
 * area) the nearest edge still wins, which is the same answer by the same arithmetic.
 *
 * Ties go to a horizontal edge: a taskbar is horizontal unless the user moved it, and the panel is taller than wide.
 */
export function trayEdgeOf(tray: WindowBounds, workArea: WindowBounds): TrayEdge {
    const centre = centreOf(tray);
    const toBottom = workArea.y + workArea.height - centre.y;
    const toTop = centre.y - workArea.y;
    const toRight = workArea.x + workArea.width - centre.x;
    const toLeft = centre.x - workArea.x;

    const vertical: TrayEdge = toBottom <= toTop ? 'bottom' : 'top';
    const horizontal: TrayEdge = toRight <= toLeft ? 'right' : 'left';
    return Math.min(toBottom, toTop) <= Math.min(toRight, toLeft) ? vertical : horizontal;
}

/** Inside the work area on both axes, after the size has been capped by it. Containment, not merely visibility. */
function clampToWorkArea(bounds: WindowBounds, workArea: WindowBounds): WindowBounds {
    const width = Math.min(bounds.width, workArea.width);
    const height = Math.min(bounds.height, workArea.height);
    return {
        width,
        height,
        x: Math.round(Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)),
        y: Math.round(Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height))
    };
}

/** The icon rectangle to anchor to when the platform reports none: the trailing corner of the work area. */
export function fallbackTrayBounds(workArea: WindowBounds, edge: TrayEdge = 'bottom'): WindowBounds {
    const atBottom = edge !== 'top';
    return {
        x: workArea.x + workArea.width - 1,
        y: atBottom ? workArea.y + workArea.height - 1 : workArea.y,
        width: 1,
        height: 1
    };
}

export interface AnchorInput {
    /** The tray icon's rectangle in screen coordinates, or null when the platform reports none (Linux often does). */
    readonly tray: WindowBounds | null;
    readonly size: WindowSize;
    readonly displays: readonly DisplayArea[];
    readonly gap: number;
    /** 'darwin' puts an unreported icon on the menu bar instead of the taskbar. */
    readonly platform: string;
}

/**
 * The panel's opening rectangle. Centred on the tray icon along the taskbar and pushed clear of it across the
 * taskbar, then clamped inside the work area of the display the icon is on - so it is never off-screen and never
 * under the taskbar, at any display arrangement.
 */
export function anchorPanel(input: AnchorInput): AnchoredPanel | undefined {
    const { displays, gap, platform, size } = input;
    const reported = input.tray !== null && input.tray.width > 0 && input.tray.height > 0 ? input.tray : null;
    const probe = reported ?? { x: 0, y: 0, width: 1, height: 1 };
    const display = displayNearestPoint(centreOf(probe), displays);
    if (display === undefined) {
        return undefined; // no displays at all: there is nowhere to put a window and nothing to guess from
    }

    const { workArea } = display;
    const defaultEdge: TrayEdge = platform === 'darwin' ? 'top' : 'bottom';
    const tray = reported ?? fallbackTrayBounds(workArea, defaultEdge);
    const edge = reported === null ? defaultEdge : trayEdgeOf(tray, workArea);
    const centre = centreOf(tray);

    const candidate: WindowBounds = {
        width: size.width,
        height: size.height,
        x: edge === 'left' ? tray.x + tray.width + gap
            : edge === 'right' ? tray.x - gap - size.width
                : Math.round(centre.x - size.width / 2),
        y: edge === 'top' ? tray.y + tray.height + gap
            : edge === 'bottom' ? tray.y - gap - size.height
                : Math.round(centre.y - size.height / 2)
    };

    return { bounds: clampToWorkArea(candidate, workArea), edge, display };
}

/** PANEL-01, asserted by the smoke and by the unit suite: the panel landed somewhere a person can see it. */
export const isPanelVisible = (bounds: WindowBounds, displays: readonly DisplayArea[]): boolean =>
    isOnAnyDisplay(bounds, displays);

/** Whether the clicked-on panel is already there, closing, or about to open. */
export type PanelClick = 'open' | 'close' | 'ignore';

export interface PanelClickInput {
    readonly open: boolean;
    /** Milliseconds since the panel last closed itself on blur, or null if it never has. */
    readonly sinceBlurCloseMs: number | null;
    readonly guardMs: number;
}

/*
 * PANEL-01. Windows delivers the panel's blur BEFORE the tray click that caused it, so by the time the click
 * arrives the panel is already gone and a naive toggle reopens it - the icon becomes a button that cannot be used
 * to put the panel away. A click inside the guard window after a blur-close is that same click, and does nothing.
 */
export function decidePanelClick(input: PanelClickInput): PanelClick {
    if (input.open) {
        return 'close';
    }
    const since = input.sinceBlurCloseMs;
    return since !== null && since >= 0 && since < input.guardMs ? 'ignore' : 'open';
}

/*
 * PANEL-01: the panel closes when it loses focus, with one exception. A window created while another application
 * holds focus can be sent a blur before it has ever been shown, and closing on that one would mean the panel
 * flickered open and shut on machines where showing it is not instantaneous.
 */
export function decidePanelBlur(input: { readonly shown: boolean }): 'close' | 'keep' {
    return input.shown ? 'close' : 'keep';
}

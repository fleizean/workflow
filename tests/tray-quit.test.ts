// Criterion 8: the app hides to the tray as v1.2.1 did, a second launch focuses the window it already has without a
// second tray icon, and Quit exits the process instead of re-hiding. Electron is a fake here; what is checked is the
// decision and the wiring, which is all that was ever wrong - v1.2.1's isQuiting flag was one assignment away from
// a window that could not be closed at all.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { findAll, read } from './helpers/ts-imports';

interface MenuItem {
    label?: string;
    type?: string;
    click?: () => void;
}

const state = {
    trays: 0,
    destroyed: 0,
    quits: 0,
    tooltip: '',
    menu: [] as MenuItem[],
    listeners: new Map<string, () => void>(),
    iconPath: '',
    resized: null as { width: number; height: number } | null,
    imageEmpty: false
};

vi.mock('electron', () => {
    class FakeTray {
        constructor() {
            state.trays += 1;
        }
        setToolTip(text: string): void { state.tooltip = text; }
        setContextMenu(menu: MenuItem[]): void { state.menu = menu; }
        on(event: string, listener: () => void): void { state.listeners.set(event, listener); }
        destroy(): void { state.destroyed += 1; }
    }
    return {
        Tray: FakeTray,
        Menu: { buildFromTemplate: (template: MenuItem[]) => template },
        app: { quit: () => { state.quits += 1; } },
        nativeImage: {
            createFromPath: (path: string) => {
                state.iconPath = path;
                return {
                    isEmpty: () => state.imageEmpty,
                    resize: (size: { width: number; height: number }) => {
                        state.resized = size;
                        return { isEmpty: () => state.imageEmpty };
                    }
                };
            }
        }
    };
});

const { createAppTray, destroyAppTray, hasAppTray } = await import('../src/main/tray');
const { decideWindowClose, isQuitting, markQuitting, resetQuittingForTests } = await import('../src/main/quit');
const { TRAY_ICON_SIZE, TRAY_TOOLTIP } = await import('../src/main/config');

const WINDOW_FILE = 'src/main/window.ts';
const LIFECYCLE_FILE = 'src/main/lifecycle.ts';

interface Window {
    visible: boolean;
    shown: number;
    hidden: number;
}

function actionsFor(win: Window) {
    return {
        show: () => { win.visible = true; win.shown += 1; },
        hide: () => { win.visible = false; win.hidden += 1; },
        isVisible: () => win.visible
    };
}

const menuItem = (label: string): MenuItem | undefined =>
    state.menu.find((item) => item.label?.startsWith(label) === true);

describe('criterion 8: the tray', () => {
    beforeEach(() => {
        destroyAppTray();
        Object.assign(state, { trays: 0, destroyed: 0, quits: 0, menu: [], listeners: new Map(), imageEmpty: false });
        resetQuittingForTests();
    });

    it('is created once, whatever asks for it - a second launch adds no second icon', () => {
        const win: Window = { visible: true, shown: 0, hidden: 0 };
        const first = createAppTray(actionsFor(win), () => undefined);
        const second = createAppTray(actionsFor(win), () => undefined);

        expect(state.trays, 'a second tray icon appeared in the notification area').toBe(1);
        expect(second).toBe(first);
        expect(hasAppTray()).toBe(true);
    });

    it('resizes the icon rather than handing Windows a full-size PNG', () => {
        createAppTray(actionsFor({ visible: true, shown: 0, hidden: 0 }), () => undefined);
        // Under vitest the ?asset import resolves to a URL; in the packaged build it is a path on disk.
        expect(state.iconPath).toContain('icon.png');
        expect(state.resized).toEqual({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
        expect(state.tooltip).toBe(TRAY_TOOLTIP);
    });

    it('still appears, and says so, when the icon cannot be read', () => {
        state.imageEmpty = true;
        const lines: string[] = [];
        expect(createAppTray(actionsFor({ visible: true, shown: 0, hidden: 0 }), (line) => lines.push(line)))
            .toBeDefined();
        expect(lines.join('\n')).toContain('icon could not be read');
    });

    it('toggles the window on a click, as v1.2.1 did', () => {
        const win: Window = { visible: true, shown: 0, hidden: 0 };
        createAppTray(actionsFor(win), () => undefined);
        const click = state.listeners.get('click');
        expect(click, 'the tray no longer answers a click').toBeDefined();

        click?.();
        expect(win.visible).toBe(false);
        click?.();
        expect(win.visible).toBe(true);
        expect([win.shown, win.hidden]).toEqual([1, 1]);
    });

    it('brings the window back from Show', () => {
        const win: Window = { visible: false, shown: 0, hidden: 0 };
        createAppTray(actionsFor(win), () => undefined);
        menuItem('Show')?.click?.();
        expect(win.visible).toBe(true);
    });

    it('quits from Quit, and marks the app as quitting first', () => {
        createAppTray(actionsFor({ visible: true, shown: 0, hidden: 0 }), () => undefined);
        expect(isQuitting()).toBe(false);

        menuItem('Quit')?.click?.();
        expect(state.quits, 'Quit did not ask the app to quit').toBe(1);
        expect(isQuitting(), 'criterion 8: without this the close handler hides the window and the process lives on')
            .toBe(true);
        expect(decideWindowClose({ quitting: isQuitting() })).toBe('close');
    });

    it('releases the icon when the app goes', () => {
        createAppTray(actionsFor({ visible: true, shown: 0, hidden: 0 }), () => undefined);
        destroyAppTray();
        expect(state.destroyed).toBe(1);
        expect(hasAppTray()).toBe(false);
    });
});

describe('criterion 8: closing the window hides it, quitting does not', () => {
    beforeEach(resetQuittingForTests);

    it('hides while the app is running and closes once it is quitting', () => {
        expect(decideWindowClose({ quitting: false })).toBe('hide');
        expect(decideWindowClose({ quitting: true })).toBe('close');
    });

    it('marks quitting once and does not forget', () => {
        markQuitting();
        markQuitting();
        expect(isQuitting()).toBe(true);
    });

    /*
     * The wiring, read rather than run: a close handler that preventDefault-ed unconditionally is exactly the bug
     * v1.2.1 shipped for a window nobody could close, and the decision has to be the one asserted above.
     */
    it('is what window.ts does on a close', () => {
        const source = ts.createSourceFile(WINDOW_FILE, read(WINDOW_FILE), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const closeHandlers = findAll(source, (node): node is ts.CallExpression =>
            ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'on' && node.arguments[0]?.getText(source) === "'close'");
        expect(closeHandlers.length, WINDOW_FILE + ': nothing handles a window close').toBeGreaterThan(0);

        const body = closeHandlers.map((call) => call.getText(source)).join('\n');
        expect(body, 'the close handler no longer asks the quit decision').toContain('decideWindowClose');
        expect(body, 'the close handler no longer hides the window').toContain('hide()');
        expect(body, 'the close is refused without asking whether the app is quitting')
            .toMatch(/decideWindowClose[\s\S]*preventDefault/);
    });

    it('is set from before-quit in lifecycle.ts, so every quit path reaches it', () => {
        const source = read(LIFECYCLE_FILE);
        expect(source, 'nothing marks the app as quitting').toContain("app.on('before-quit'");
        expect(source).toContain('markQuitting');
        expect(source, 'the tray icon would outlive the process on Windows').toContain('destroyAppTray');
    });
});

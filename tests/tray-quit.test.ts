// Criterion 8: the app hides to the tray as v1.2.1 did, a second launch focuses the window it already has without a
// second tray icon, and Quit exits the process instead of re-hiding. Electron is a fake here; what is checked is the
// decision and the wiring, which is all that was ever wrong - v1.2.1's isQuiting flag was one assignment away from
// a window that could not be closed at all.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { findAll, read } from './helpers/ts-imports';

interface MenuItem {
    label?: string;
    enabled?: boolean;
    type?: string;
    click?: () => void;
}

const state = {
    trayThrows: false,
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
            if (state.trayThrows) throw new Error('no notification area');
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

const {
    RESET_POSITION_LABEL, announceTrayUpdate, appTrayMenu, createAppTray, destroyAppTray, hasAppTray
} = await import('../src/main/tray');
const { decideWindowClose, isQuitting, markQuitting, resetQuittingForTests } = await import('../src/main/quit');
const { TRAY_ICON_SIZE, TRAY_TOOLTIP } = await import('../src/main/config');

const WINDOW_FILE = 'src/main/window.ts';
const LIFECYCLE_FILE = 'src/main/lifecycle.ts';
const CONTRACT_FILE = 'src/shared/ipc/contract.ts';
const CHANNELS_FILE = 'src/shared/ipc/channels.ts';

interface Window {
    visible: boolean;
    shown: number;
    hidden: number;
    reset: number;
    releases: number;
}

function actionsFor(win: Window) {
    return {
        show: () => { win.visible = true; win.shown += 1; },
        hide: () => { win.visible = false; win.hidden += 1; },
        isVisible: () => win.visible,
        resetPosition: () => { win.reset += 1; },
        openReleases: () => { win.releases += 1; }
    };
}

/** Every case that does not care about the window's state starts from the same one. */
const freshWindow = (visible: boolean): Window => ({ visible, shown: 0, hidden: 0, reset: 0, releases: 0 });

/** Not the real version: the menu must read whatever it is handed, not a constant this test could also read. */
const TEST_VERSION = '9.8.7';

const menuItem = (label: string): MenuItem | undefined =>
    state.menu.find((item) => item.label?.startsWith(label) === true);

describe('criterion 8: the tray', () => {
    beforeEach(() => {
        destroyAppTray();
        Object.assign(state,
            { trays: 0, destroyed: 0, quits: 0, menu: [], listeners: new Map(), imageEmpty: false, trayThrows: false });
        resetQuittingForTests();
    });

    it('is created once, whatever asks for it - a second launch adds no second icon', () => {
        const win: Window = freshWindow(true);
        const first = createAppTray(actionsFor(win), TEST_VERSION, () => undefined);
        const second = createAppTray(actionsFor(win), TEST_VERSION, () => undefined);

        expect(state.trays, 'a second tray icon appeared in the notification area').toBe(1);
        expect(second).toBe(first);
        expect(hasAppTray()).toBe(true);
    });

    it('resizes the icon rather than handing Windows a full-size PNG', () => {
        createAppTray(actionsFor(freshWindow(true)), TEST_VERSION, () => undefined);
        // Under vitest the ?asset import resolves to a URL; in the packaged build it is a path on disk.
        expect(state.iconPath).toContain('icon.png');
        expect(state.resized).toEqual({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
        expect(state.tooltip).toBe(TRAY_TOOLTIP);
    });

    it('still appears, and says so, when the icon cannot be read', () => {
        state.imageEmpty = true;
        const lines: string[] = [];
        expect(createAppTray(actionsFor(freshWindow(true)), TEST_VERSION, (line: string) => lines.push(line)))
            .toBeDefined();
        expect(lines.join('\n')).toContain('icon could not be read');
    });

    it('does not fail startup when no tray can be created, and leaves the app quittable', () => {
        state.trayThrows = true;
        const lines: string[] = [];
        expect(createAppTray(actionsFor(freshWindow(true)), TEST_VERSION, (line: string) => lines.push(line)))
            .toBeUndefined();
        expect(hasAppTray()).toBe(false);
        expect(lines.join('\n')).toContain('no tray could be created');
        expect(decideWindowClose({ quitting: false, hasTray: hasAppTray() }), 'the only way out was Task Manager')
            .toBe('close');
    });

    it('toggles the window on a click, as v1.2.1 did', () => {
        const win: Window = freshWindow(true);
        createAppTray(actionsFor(win), TEST_VERSION, () => undefined);
        const click = state.listeners.get('click');
        expect(click, 'the tray no longer answers a click').toBeDefined();

        click?.();
        expect(win.visible).toBe(false);
        click?.();
        expect(win.visible).toBe(true);
        expect([win.shown, win.hidden]).toEqual([1, 1]);
    });

    it('brings the window back from Show', () => {
        const win: Window = freshWindow(false);
        createAppTray(actionsFor(win), TEST_VERSION, () => undefined);
        menuItem('Show')?.click?.();
        expect(win.visible).toBe(true);
    });

    it('quits from Quit, and marks the app as quitting first', () => {
        createAppTray(actionsFor(freshWindow(true)), TEST_VERSION, () => undefined);
        expect(isQuitting()).toBe(false);

        menuItem('Quit')?.click?.();
        expect(state.quits, 'Quit did not ask the app to quit').toBe(1);
        expect(isQuitting(), 'criterion 8: without this the close handler hides the window and the process lives on')
            .toBe(true);
        expect(decideWindowClose({ quitting: isQuitting(), hasTray: hasAppTray() })).toBe('close');
    });

    it('releases the icon when the app goes', () => {
        createAppTray(actionsFor(freshWindow(true)), TEST_VERSION, () => undefined);
        destroyAppTray();
        expect(state.destroyed).toBe(1);
        expect(hasAppTray()).toBe(false);
    });

    /*
     * Phase 10 criterion 5: the user can reset the window position from the tray menu. A frameless window that has
     * ended up off-screen has no title bar to drag and no system Move item, so the tray is the only way back.
     */
    it('offers Reset window position, and its click reaches the action', () => {
        const win: Window = freshWindow(true);
        createAppTray(actionsFor(win), TEST_VERSION, () => undefined);
        const item = menuItem(RESET_POSITION_LABEL);
        expect(item, 'the tray menu offers no way to recover an off-screen window').toBeDefined();
        item?.click?.();
        expect(win.reset).toBe(1);
        // Beside Show rather than beside Quit: both are ways of getting the window back, and one of them destroys
        // nothing. A reset item under Quit is one slip away from ending the app instead of moving it. Stated as
        // "after Show and separated from Quit" rather than "before the first separator", because REPO-06 put a
        // version line and its own separator above Show.
        const show = state.menu.findIndex((entry) => entry.label === 'Show Workflow');
        const reset = state.menu.findIndex((entry) => entry.label === RESET_POSITION_LABEL);
        const quit = state.menu.findIndex((entry) => entry.label?.startsWith('Quit') === true);
        expect(show, 'the menu offers no Show').toBeGreaterThanOrEqual(0);
        expect(reset, 'Reset window position is above Show rather than beside it').toBeGreaterThan(show);
        expect(reset, 'Reset window position is below Quit').toBeLessThan(quit);
        expect(
            state.menu.slice(reset, quit).some((entry) => entry.type === 'separator'),
            'nothing separates Reset window position from Quit, so one slip ends the app instead of moving it'
        ).toBe(true);
    });

    /*
     * REPO-06. Two halves, and the second is the one that matters: the version line is always there, and the update
     * line is there ONLY when a check actually found something newer. A permanent "check for updates" item would be
     * an affordance for a thing this app does not do on demand.
     */
    it('states the installed version it was handed, disabled', () => {
        createAppTray(actionsFor(freshWindow(true)), TEST_VERSION, () => undefined);
        const item = menuItem('Workflow ' + TEST_VERSION);
        expect(item, 'the tray does not say which version is installed').toBeDefined();
        expect(item?.enabled, 'the version line is clickable, so it reads as a command').toBe(false);
        expect(state.menu.findIndex((entry) => entry.label === 'Workflow ' + TEST_VERSION),
            'the version is not the first thing the menu says').toBe(0);
    });

    it('offers nothing about updates until one is found', () => {
        createAppTray(actionsFor(freshWindow(true)), TEST_VERSION, () => undefined);
        expect(state.menu.filter((entry) => entry.label?.includes('pdate') === true),
            'the menu talks about updates before any check has run').toEqual([]);
    });

    it('adds an update item when one is announced, and its click opens the releases page', () => {
        const win: Window = freshWindow(true);
        const actions = actionsFor(win);
        createAppTray(actions, TEST_VERSION, () => undefined);
        announceTrayUpdate('9.9.0', actions);

        const item = menuItem('Update available: 9.9.0');
        expect(item, 'a newer version was found and the tray says nothing').toBeDefined();
        item?.click?.();
        expect(win.releases, 'the update item leads nowhere').toBe(1);
        // Still there, and still first: the version the user has is the fact, the update is the offer.
        expect(state.menu[0]?.label).toBe('Workflow ' + TEST_VERSION);
        expect(state.menu[1]?.label).toBe('Update available: 9.9.0');
    });

    it('redraws once per version and never takes the notice away', () => {
        const win: Window = freshWindow(true);
        const actions = actionsFor(win);
        createAppTray(actions, TEST_VERSION, () => undefined);
        announceTrayUpdate('9.9.0', actions);
        const afterFirst = state.menu;
        announceTrayUpdate('9.9.0', actions);
        expect(state.menu, 'the same version rebuilt the menu again').toBe(afterFirst);
        announceTrayUpdate('9.9.1', actions);
        expect(menuItem('Update available: 9.9.1'), 'a newer announcement did not replace the old one').toBeDefined();
        expect(menuItem('Update available: 9.9.0'), 'both announcements are on the menu').toBeUndefined();
    });

    it('announces nothing when there is no tray to announce it on', () => {
        const win: Window = freshWindow(true);
        state.trayThrows = true;
        createAppTray(actionsFor(win), TEST_VERSION, () => undefined);
        expect(() => { announceTrayUpdate('9.9.0', actionsFor(win)); },
            'a machine with no notification area crashed on an update notice').not.toThrow();
        expect(state.menu, 'a menu was built for a tray that does not exist').toEqual([]);
    });

    it('forgets the version and the notice when the icon goes', () => {
        const win: Window = freshWindow(true);
        const actions = actionsFor(win);
        createAppTray(actions, TEST_VERSION, () => undefined);
        announceTrayUpdate('9.9.0', actions);
        destroyAppTray();
        createAppTray(actions, '1.0.0', () => undefined);
        expect(menuItem('Workflow 1.0.0'), 'the rebuilt tray carries the old version').toBeDefined();
        expect(menuItem('Update available'), 'the rebuilt tray inherited a notice from the previous process')
            .toBeUndefined();
    });

    it('lets go of the menu with the icon, so a rebuilt tray cannot be driven through the old one', () => {
        createAppTray(actionsFor(freshWindow(true)), TEST_VERSION, () => undefined);
        expect(appTrayMenu()).toBeDefined();
        destroyAppTray();
        expect(appTrayMenu()).toBeUndefined();
    });
});

describe('criterion 8: a system close hides the window, quitting does not', () => {
    beforeEach(resetQuittingForTests);

    it('hides while the app is running and closes once it is quitting', () => {
        expect(decideWindowClose({ quitting: false, hasTray: true })).toBe('hide');
        expect(decideWindowClose({ quitting: true, hasTray: true })).toBe('close');
    });

    /*
     * WR-03. The close handler hid unless the app was quitting, and markQuitting was reachable only from before-quit
     * and a tray menu that does not exist when new Tray() fails. Alt+F4 and the titlebar both hid, so the user was
     * left with a process only Task Manager could end - and force-killing it costs up to PERSIST_INTERVAL_MS of
     * counted time. With no tray the close has to close.
     */
    it('closes rather than hides when there is no tray to hide to', () => {
        expect(decideWindowClose({ quitting: false, hasTray: false })).toBe('close');
        expect(decideWindowClose({ quitting: true, hasTray: false })).toBe('close');
    });

    it('is what window.ts asks on a system close, and what the hide button asks for', () => {
        const source = read(WINDOW_FILE);
        expect(source, 'the close handler no longer asks whether there is a tray')
            .toMatch(/decideWindowClose\(\{[^}]*hasTray/);
        // WR-03: hiding into a tray that does not exist leaves a process only Task Manager can end.
        expect(source, 'the hide button hides into a tray that may not exist')
            .toMatch(/hide\(\): void \{[\s\S]*?hasAppTray\(\)/);
    });

    /*
     * Owner decision 2026-09-13. The titlebar's X ends the process, and it must end it the way the tray's Quit
     * item does: markQuitting first, then app.quit(). Without the flag the close handler above hides the window
     * and the process lives on - the bug v1.2.1 shipped - and with app.exit() the will-quit handlers never run,
     * so the timer never flushes the seconds it was holding (D-32).
     */
    it('quits from the titlebar the same way the tray does: the flag, then app.quit', () => {
        const source = ts.createSourceFile(
            WINDOW_FILE, read(WINDOW_FILE), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const [quit] = findAll(source, (node): node is ts.MethodDeclaration =>
            ts.isMethodDeclaration(node) && node.name.getText(source) === 'quit');
        expect(quit, WINDOW_FILE + ': nothing on the shell controls quits').toBeDefined();

        const body = quit?.body?.getText(source) ?? '';
        expect(body, 'the quit does not mark the app as quitting, so the close handler would re-hide the window')
            .toContain('markQuitting()');
        expect(body, 'the quit does not ask the app to quit').toContain('app.quit()');
        expect(body, 'app.exit skips will-quit, and the timer flushes there').not.toContain('app.exit');
        expect(body.indexOf('markQuitting'), 'the flag must be set before the quit, not after')
            .toBeLessThan(body.indexOf('app.quit'));
    });

    // The renderer cannot ask for the old meaning any more: the channel that hid on a close is gone.
    it('has no window:close channel left to ask for', () => {
        // Quoted, because contract.ts names the retired channel in prose to say why it is gone.
        const retired = String.fromCharCode(39) + 'window:close' + String.fromCharCode(39);
        expect(read(CHANNELS_FILE), CHANNELS_FILE + ' still lists the channel that meant both things')
            .not.toContain(retired);
        expect(read(CONTRACT_FILE), CONTRACT_FILE + ' still declares the channel that meant both things')
            .not.toContain(retired);
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

/*
 * PANEL-01 and PANEL-04's lifetime half, driven through the real module with Electron faked.
 *
 * What is checked is what was ever at risk: exactly one panel exists at a time, it is DESTROYED rather than hidden
 * when it loses focus, the click that closed it does not reopen it, it creates no second tray icon and nothing
 * about it is a main window - so close-to-tray, the saved window rectangle and window-all-closed all still mean
 * what Phase 5 and Phase 10 made them mean. The anchoring itself is tests/panel-anchor.test.ts's; here it is only
 * asserted that the window was given the rectangle the anchor computed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { eagerImports, read } from './helpers/ts-imports';

interface Options {
    x: number;
    y: number;
    width: number;
    height: number;
    frame?: boolean;
    resizable?: boolean;
    skipTaskbar?: boolean;
    alwaysOnTop?: boolean;
    show?: boolean;
    webPreferences?: { contextIsolation?: boolean; nodeIntegration?: boolean; sandbox?: boolean; preload?: string };
}

interface Fake {
    options: Options;
    bounds: { x: number; y: number; width: number; height: number } | null;
    shows: number;
    focuses: number;
    destroyed: boolean;
    loaded: { file: string; hash?: string } | null;
    listeners: Map<string, (() => void)[]>;
    once: Map<string, () => void>;
    /** The renderer-loss guard's two halves: what it subscribed to, and whether it reloaded. */
    contentsListeners: Map<string, ((event: unknown, details: { reason: string }) => void)[]>;
    reloads: number;
}

const state = {
    created: [] as Fake[],
    trays: 0,
    displays: [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    logs: [] as string[]
};

vi.mock('electron', () => {
    class FakeBrowserWindow {
        readonly fake: Fake;
        readonly webContents = {
            isDestroyed: (): boolean => this.fake.destroyed,
            isCrashed: (): boolean => false,
            send: (): void => undefined,
            setAudioMuted: (): void => undefined,
            reload: (): void => { this.fake.reloads += 1; },
            on: (event: string, listener: (e: unknown, details: { reason: string }) => void): void => {
                const list = this.fake.contentsListeners.get(event) ?? [];
                list.push(listener);
                this.fake.contentsListeners.set(event, list);
            }
        };

        constructor(options: Options) {
            this.fake = {
                options,
                bounds: null,
                shows: 0,
                focuses: 0,
                destroyed: false,
                loaded: null,
                listeners: new Map(),
                once: new Map(),
                contentsListeners: new Map(),
                reloads: 0
            };
            state.created.push(this.fake);
        }

        on(event: string, listener: () => void): void {
            const list = this.fake.listeners.get(event) ?? [];
            list.push(listener);
            this.fake.listeners.set(event, list);
        }
        once(event: string, listener: () => void): void { this.fake.once.set(event, listener); }
        isDestroyed(): boolean { return this.fake.destroyed; }
        destroy(): void {
            this.fake.destroyed = true;
            for (const listener of this.fake.listeners.get('closed') ?? []) listener();
        }
        setBounds(bounds: { x: number; y: number; width: number; height: number }): void { this.fake.bounds = bounds; }
        show(): void { this.fake.shows += 1; }
        focus(): void { this.fake.focuses += 1; }
        loadFile(file: string, options?: { hash?: string }): Promise<void> {
            this.fake.loaded = { file, ...(options?.hash === undefined ? {} : { hash: options.hash }) };
            return Promise.resolve();
        }
        loadURL(url: string): Promise<void> {
            this.fake.loaded = { file: url };
            return Promise.resolve();
        }
    }

    class FakeTray {
        constructor() { state.trays += 1; }
    }

    return {
        BrowserWindow: FakeBrowserWindow,
        Tray: FakeTray,
        screen: { getAllDisplays: () => state.displays },
        app: { isPackaged: true, getPath: () => '', quit: () => undefined },
        Menu: { buildFromTemplate: (template: unknown) => template },
        nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) }) }
    };
});

const { PANEL_GAP, PANEL_REOPEN_GUARD_MS, PANEL_ROUTE_HASH, PANEL_WINDOW } = await import('../src/main/config');
const {
    clickTray, closePanel, isPanelOpen, loadPanel, openPanel, panelWindows, resetPanelForTests
} = await import('../src/main/panel');
const { mainWindows } = await import('../src/main/window');
const { createElectronRendererBus } = await import('../src/main/adapters/electron-renderer-bus.adapter');

const log = (line: string): void => { state.logs.push(line); };
const TRAY_ICON = { x: 1000, y: 1048, width: 16, height: 16 };
const open = (tray = TRAY_ICON, show = true) => openPanel({ tray, show, log });
const last = (): Fake | undefined => state.created[state.created.length - 1];
const fire = (fake: Fake, event: string): void => {
    for (const listener of fake.listeners.get(event) ?? []) listener();
};

beforeEach(() => {
    state.created = [];
    state.trays = 0;
    state.logs = [];
    state.displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
});

afterEach(() => { resetPanelForTests(); });

describe('PANEL-01: one panel, at the icon, and no second tray', () => {
    it('opens one window at the rectangle the anchor computed', () => {
        const win = open();
        expect(win, 'no panel was created').toBeDefined();
        expect(state.created).toHaveLength(1);
        const fake = last();
        expect(fake?.options.width).toBe(PANEL_WINDOW.width);
        expect(fake?.options.height).toBe(PANEL_WINDOW.height);
        expect(fake?.options.x, 'the panel was not centred on the icon').toBe(1008 - PANEL_WINDOW.width / 2);
        expect(fake?.options.y, 'the panel was not lifted clear of the taskbar')
            .toBe(TRAY_ICON.y - PANEL_GAP - PANEL_WINDOW.height);
    });

    it('creates no tray of its own, whatever happens to it', () => {
        open();
        clickTray(() => TRAY_ICON, log);
        closePanel();
        expect(state.trays, 'the panel put a second icon in the notification area').toBe(0);
    });

    it('is not a main window, so close-to-tray and the saved rectangle are not about it', () => {
        open();
        expect(mainWindows(), 'the panel joined the main window list').toEqual([]);
    });

    it('carries the hardened webPreferences, frameless and out of the taskbar', () => {
        open();
        const fake = last();
        expect(fake?.options.frame).toBe(false);
        expect(fake?.options.resizable).toBe(false);
        expect(fake?.options.skipTaskbar, 'the panel would appear in the taskbar and in Alt+Tab').toBe(true);
        expect(fake?.options.alwaysOnTop).toBe(true);
        expect(fake?.options.show, 'the panel was shown before it had been positioned').toBe(false);
        expect(fake?.options.webPreferences?.contextIsolation).toBe(true);
        expect(fake?.options.webPreferences?.nodeIntegration).toBe(false);
        expect(fake?.options.webPreferences?.sandbox).toBe(true);
        expect(fake?.options.webPreferences?.preload, 'the panel loads no preload, so it has no bridge')
            .toContain('preload');
    });

    it('loads the one document at the panel route, not a page of its own (PANEL-05)', async () => {
        const win = open(TRAY_ICON, false);
        expect(win).toBeDefined();
        await loadPanel(win as never);
        expect(last()?.loaded?.file, 'the panel loaded something other than the renderer entry')
            .toContain('index.html');
        expect(last()?.loaded?.hash).toBe(PANEL_ROUTE_HASH.replace('#', ''));
    });

    it('shows and focuses itself only once it is ready, at the anchored rectangle', () => {
        open();
        const fake = last();
        expect(fake?.shows, 'the panel was shown before ready-to-show').toBe(0);
        fake?.once.get('ready-to-show')?.();
        expect(fake?.bounds, 'the panel was shown without being positioned first').toEqual({
            x: fake?.options.x, y: fake?.options.y, width: PANEL_WINDOW.width, height: PANEL_WINDOW.height
        });
        expect([fake?.shows, fake?.focuses]).toEqual([1, 1]);
    });

    it('replaces an open panel rather than stacking a second one', () => {
        open();
        const first = last();
        open();
        expect(state.created, 'the second open did not create a window').toHaveLength(2);
        expect(first?.destroyed, 'two panels were open at once').toBe(true);
        expect(panelWindows()).toHaveLength(1);
    });

    it('reports nowhere to open when the screen module names no display', () => {
        state.displays = [];
        expect(open()).toBeUndefined();
        expect(state.created).toEqual([]);
        expect(state.logs.join('\n')).toContain('no display was reported');
    });
});

/*
 * PANEL-04's lifetime half. A hidden panel keeps a webContents subscribed to timer:tick for the life of the
 * process, which is a subscription outliving its surface - the Phase 7 defect in its other direction. The panel is
 * destroyed, so the document ends and the subscription ends with it.
 */
describe('PANEL-04: the panel ends on blur, and nothing of it survives', () => {
    it('destroys the window rather than hiding it', () => {
        open();
        const fake = last();
        fake?.once.get('ready-to-show')?.();
        fire(fake as Fake, 'blur');
        expect(fake?.destroyed, 'the panel was hidden, so its tick subscription outlived it').toBe(true);
        expect(isPanelOpen()).toBe(false);
        expect(panelWindows(), 'the bus would still try to deliver to the closed panel').toEqual([]);
    });

    it('survives a blur raised before it was ever shown', () => {
        open();
        const fake = last();
        fire(fake as Fake, 'blur');
        expect(fake?.destroyed, 'a blur before the first show closed the panel on top of itself').toBe(false);
        expect(isPanelOpen()).toBe(true);
    });

    it('leaves no registration behind when the window is closed from under it', () => {
        const win = open();
        (win as unknown as { destroy(): void }).destroy();
        expect(isPanelOpen()).toBe(false);
        expect(closePanel(), 'closing an already-closed panel threw').toBeUndefined();
    });

    it('is a renderer-bus target while it is open, and only while it is open', () => {
        const sent: string[] = [];
        const bus = createElectronRendererBus(log);
        bus.emit('data:changed', { domains: ['stats'] });

        open();
        const fake = last();
        const win = panelWindows()[0] as unknown as { webContents: { send(channel: string): void } };
        win.webContents.send = (channel: string): void => { sent.push(channel); };
        bus.emit('data:changed', { domains: ['stats'] });
        expect(sent, 'the panel never received the event, so its figures could not move').toEqual(['data:changed']);

        fake?.once.get('ready-to-show')?.();
        fire(fake as Fake, 'blur');
        bus.emit('data:changed', { domains: ['stats'] });
        expect(sent, 'the closed panel was still being sent events').toEqual(['data:changed']);
    });
});

/*
 * The macOS lid-close freeze reaches the panel too: it draws the same tick stream through the same bus, so a dead
 * panel renderer is a second window whose figures will never move again. Measured in Electron 44.2.0, a dead render
 * process leaves the window undestroyed and send() silent, so nothing short of this handler notices.
 */
describe('the panel comes back when its renderer is lost', () => {
    const crash = (fake: Fake, reason = 'crashed'): void => {
        for (const listener of fake.contentsListeners.get('render-process-gone') ?? []) {
            listener({}, { reason });
        }
    };

    it('subscribes to render-process-gone at all, which nothing in src/ used to', () => {
        open();
        expect([...(last()?.contentsListeners.keys() ?? [])]).toContain('render-process-gone');
    });

    it('reloads the panel and says why', () => {
        open();
        const fake = last() as Fake;
        crash(fake);
        expect(fake.reloads, 'a dead panel renderer was left on screen').toBe(1);
        expect(state.logs.join(' ')).toContain('panel: the renderer process is gone (crashed)');
    });

    it('does not reload a panel the blur has already destroyed', () => {
        open();
        const fake = last() as Fake;
        fake.once.get('ready-to-show')?.();
        fire(fake, 'blur');
        crash(fake);
        expect(fake.reloads, 'a destroyed panel was reloaded back onto the screen').toBe(0);
    });
});

describe('PANEL-01: what a click on the icon does', () => {
    it('opens, then closes, then opens again once the guard has passed', () => {
        expect(clickTray(() => TRAY_ICON, log)).toBe('open');
        expect(isPanelOpen()).toBe(true);
        expect(clickTray(() => TRAY_ICON, log)).toBe('close');
        expect(isPanelOpen()).toBe(false);
        expect(clickTray(() => TRAY_ICON, log), 'a later click could not reopen the panel').toBe('open');
    });

    /*
     * The real sequence on Windows: the click moves focus away from the panel, the blur arrives first and closes
     * it, and the click then lands on a panel that is already gone. Without the guard the icon reopens what the
     * user was closing, and the panel can only be dismissed by clicking somewhere else entirely.
     */
    it('ignores the click whose own blur has just closed the panel', () => {
        clickTray(() => TRAY_ICON, log);
        const fake = last();
        fake?.once.get('ready-to-show')?.();
        fire(fake as Fake, 'blur');
        expect(isPanelOpen()).toBe(false);
        expect(clickTray(() => TRAY_ICON, log), 'the click that closed the panel reopened it').toBe('ignore');
        expect(isPanelOpen()).toBe(false);
    });

    it('opens again once the guard window has passed', () => {
        vi.useFakeTimers();
        try {
            clickTray(() => TRAY_ICON, log);
            const fake = last();
            fake?.once.get('ready-to-show')?.();
            fire(fake as Fake, 'blur');
            vi.advanceTimersByTime(PANEL_REOPEN_GUARD_MS);
            expect(clickTray(() => TRAY_ICON, log)).toBe('open');
        } finally {
            vi.useRealTimers();
        }
    });

    it('asks for the icon rectangle at the click rather than holding one', () => {
        let asked = 0;
        clickTray(() => { asked += 1; return TRAY_ICON; }, log);
        clickTray(() => { asked += 1; return TRAY_ICON; }, log); // closes
        clickTray(() => { asked += 1; return TRAY_ICON; }, log); // opens again
        expect(asked, 'the rectangle was captured once instead of read per click').toBeGreaterThan(1);
    });
});

/*
 * ARCH-01, read off the source: the panel module may construct a window, and it may not become a second place the
 * tray, the database or a service is reached from.
 */
describe('ARCH-01: what the panel module is allowed to know', () => {
    const PANEL = 'src/main/panel.ts';

    it('names no tray at all, so it cannot create or destroy one', () => {
        const source = read(PANEL);
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        expect(code, PANEL + ' constructs a Tray').not.toMatch(/new\s+Tray\b/);
        expect(code, PANEL + ' imports the tray module').not.toContain('./tray');
    });

    it('imports only the shell modules a window factory needs', () => {
        const source = ts.createSourceFile(PANEL, read(PANEL), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const specifiers = eagerImports(source, true).map((entry) => entry.specifier).sort();
        expect(specifiers).toEqual([
            './config', './errors', './panel-anchor', './window', 'electron', 'node:path'
        ]);
    });
});

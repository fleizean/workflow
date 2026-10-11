/*
 * The necessary cause of the macOS lid-close freeze, and the handler that was missing.
 *
 * Measured in real Electron 44.2.0 (investigation electron-probe-1/2, 2026-10-11): after the render process dies,
 * webContents.isCrashed() is TRUE, webContents.isDestroyed() is FALSE, win.isDestroyed() is FALSE, and
 * webContents.send() does NOT throw. So main went on pushing timer:tick and data:changed into a void - the window
 * kept its last painted frame, every click landed nowhere, and nothing in src/ said a word: a grep for
 * render-process-gone, unresponsive and isCrashed returned zero matches. reload() was measured to recover it
 * completely: a new OS pid, the page executing again, and the renderer's opening timer:getSnapshot re-read.
 *
 * The guard is driven here over a stand-in window, because what is asserted is the decision - reload, wait, or
 * leave it alone - and no Electron is needed to make it. tests/panel-window.test.ts drives the same function
 * through the real openPanel, and the wiring assertions at the bottom hold both window sets to using it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import type { BrowserWindow } from 'electron';
import { UNRESPONSIVE_RELOAD_DELAY_MS } from '../src/main/config';
import { reviveOnRendererLoss } from '../src/main/window';
import { findAll, read, scriptKindFor } from './helpers/ts-imports';

type ContentsListener = (event: unknown, details: { reason: string }) => void;

interface Fake {
    destroyed: boolean;
    reloads: number;
    reloadThrows: boolean;
    readonly lines: string[];
    readonly window: Map<string, (() => void)[]>;
    readonly contents: Map<string, ContentsListener[]>;
}

function guarded(): Fake {
    const fake: Fake = {
        destroyed: false,
        reloads: 0,
        reloadThrows: false,
        lines: [],
        window: new Map(),
        contents: new Map()
    };
    const win = {
        isDestroyed: () => fake.destroyed,
        on: (event: string, listener: () => void) => {
            fake.window.set(event, [...(fake.window.get(event) ?? []), listener]);
        },
        webContents: {
            on: (event: string, listener: ContentsListener) => {
                fake.contents.set(event, [...(fake.contents.get(event) ?? []), listener]);
            },
            reload: () => {
                if (fake.reloadThrows) throw new Error('the window was being torn down');
                fake.reloads += 1;
            }
        }
    };
    reviveOnRendererLoss(win as unknown as BrowserWindow, 'window', (line) => fake.lines.push(line));
    return fake;
}

const fireWindow = (fake: Fake, event: string): void => {
    for (const listener of fake.window.get(event) ?? []) listener();
};

const fireContents = (fake: Fake, event: string, reason = 'crashed'): void => {
    for (const listener of fake.contents.get(event) ?? []) listener({}, { reason });
};

afterEach(() => { vi.useRealTimers(); });

describe('a renderer that is gone is noticed, reloaded and written down', () => {
    it('subscribes to the two events the app had no handler for', () => {
        const fake = guarded();
        expect([...fake.contents.keys()]).toContain('render-process-gone');
        expect([...fake.window.keys()]).toContain('unresponsive');
    });

    it('reloads at once when the render process is gone, and names the reason', () => {
        const fake = guarded();
        fireContents(fake, 'render-process-gone', 'oom');
        expect(fake.reloads, 'the window kept its last painted frame forever').toBe(1);
        expect(fake.lines, 'the loss was handled in silence, which is how it went undiagnosed').toHaveLength(1);
        expect(fake.lines[0]).toContain('process is gone (oom)');
    });

    it('leaves a destroyed window alone, because there is nothing to bring back', () => {
        const fake = guarded();
        fake.destroyed = true;
        fireContents(fake, 'render-process-gone');
        expect(fake.reloads).toBe(0);
        expect(fake.lines).toEqual([]);
    });

    it('reports a reload that throws rather than raising it into an Electron event handler', () => {
        const fake = guarded();
        fake.reloadThrows = true;
        expect(() => { fireContents(fake, 'render-process-gone'); }).not.toThrow();
        expect(fake.lines.join(' ')).toContain('could not be reloaded');
    });
});

describe('an unresponsive renderer is given time before it is reloaded', () => {
    it('says so immediately and reloads only once the grace period has passed', () => {
        vi.useFakeTimers();
        const fake = guarded();
        fireWindow(fake, 'unresponsive');
        expect(fake.lines, 'a hang nobody mentions is the owner pressing a dead button').toHaveLength(1);
        expect(fake.lines[0]).toContain('stopped answering');

        vi.advanceTimersByTime(UNRESPONSIVE_RELOAD_DELAY_MS - 1);
        expect(fake.reloads, 'a renderer that was merely busy had its window reloaded under the user').toBe(0);
        vi.advanceTimersByTime(1);
        expect(fake.reloads).toBe(1);
    });

    it('cancels the reload when the renderer answers again', () => {
        vi.useFakeTimers();
        const fake = guarded();
        fireWindow(fake, 'unresponsive');
        fireWindow(fake, 'responsive');
        vi.advanceTimersByTime(UNRESPONSIVE_RELOAD_DELAY_MS * 10);
        expect(fake.reloads, 'a renderer that came back was reloaded anyway, losing whatever was typed').toBe(0);
        expect(fake.lines.join(' ')).toContain('answering again');
    });

    it('drops the pending reload when the window closes first', () => {
        vi.useFakeTimers();
        const fake = guarded();
        fireWindow(fake, 'unresponsive');
        fireWindow(fake, 'closed');
        fake.destroyed = true;
        vi.advanceTimersByTime(UNRESPONSIVE_RELOAD_DELAY_MS * 10);
        expect(fake.reloads).toBe(0);
    });

    it('does not stack a timer per unresponsive event', () => {
        vi.useFakeTimers();
        const fake = guarded();
        for (let i = 0; i < 5; i += 1) fireWindow(fake, 'unresponsive');
        vi.advanceTimersByTime(UNRESPONSIVE_RELOAD_DELAY_MS * 10);
        expect(fake.reloads, 'five hang reports reloaded the window five times').toBe(1);
    });
});

/*
 * PANEL-04: rendererWindows() is mainWindows() + panelWindows(), so the tick stream has two possible dead ends and
 * a fix covering one of them would leave the tray panel exactly as it was.
 */
describe('both window sets are guarded, not just the main one', () => {
    const callsInside = (file: string, fn: string, callee: string): number => {
        const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, scriptKindFor(file));
        const declarations = findAll(source, (node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === fn);
        expect(declarations, 'no function named ' + fn + ' in ' + file).toHaveLength(1);
        return declarations.flatMap((declaration) => findAll(declaration, (node): node is ts.CallExpression =>
            ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee)).length;
    };

    it.each([
        ['src/main/window.ts', 'createMainWindow'],
        ['src/main/panel.ts', 'openPanel']
    ])('%s guards every window %s makes', (file, fn) => {
        expect(callsInside(file, fn, 'reviveOnRendererLoss'),
            file + ': a window is created without the renderer-loss guard').toBe(1);
    });
});

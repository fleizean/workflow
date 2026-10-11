/*
 * PANEL-02, run rather than read: the panel's Stop is a request for the main window's save form, and it is answered
 * by a subscription whose lifetime is the window's rather than Home's.
 *
 * The whole point of the shape is the route the window happens to be on. The request arrives for a window that may
 * be showing Settings, so Home is not mounted and cannot be the subscriber - which is exactly the arrangement
 * Phase 7's review found the timer tick in (tests/shell-tick-lifetime.test.ts). The subscription mounted below is
 * the one app/providers mounts, through the same facade.
 */

import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { findAll, read, stripCommentsAndStrings } from './helpers/ts-imports';
import { subscribeSaveRequests } from '@renderer/app/providers/save-request-feed';
import { useUiStore, writeSaveRequest } from '@renderer/store/ui.store';
import { API_BRIDGE_KEY } from '@shared/constants/bridge';
import { ipcEvents } from '@shared/ipc/contract';

type Listener = (payload: { requestedAt: number }) => void;

const listeners = new Set<Listener>();

/** The preload bridge's event half, with the same disposer contract the real one has. */
function installBridge(): void {
    (globalThis as unknown as Record<string, unknown>)[API_BRIDGE_KEY] = {
        on: {
            'shell:saveRequested': (listener: Listener) => {
                listeners.add(listener);
                return (): void => { listeners.delete(listener); };
            }
        }
    };
}

const request = (requestedAt: number): void => {
    for (const listener of listeners) listener({ requestedAt });
};

afterEach(() => {
    listeners.clear();
    delete (globalThis as unknown as Record<string, unknown>)[API_BRIDGE_KEY];
    useUiStore.getState().clearSaveRequest();
});

describe('PANEL-02: the save request reaches the window, not the screen', () => {
    it('writes the nonce main sent into the store the shell and Home both read', () => {
        installBridge();
        const stop = subscribeSaveRequests(({ requestedAt }) => { writeSaveRequest(requestedAt); });
        try {
            expect(useUiStore.getState().saveRequestedAt, 'something was pending before anything asked').toBeNull();
            request(1_760_000_000_000);
            expect(useUiStore.getState().saveRequestedAt).toBe(1_760_000_000_000);
        } finally {
            stop();
        }
    });

    it('is cleared by whoever answered it, and a second request is a second value', () => {
        installBridge();
        const stop = subscribeSaveRequests(({ requestedAt }) => { writeSaveRequest(requestedAt); });
        try {
            request(10);
            useUiStore.getState().clearSaveRequest();
            expect(useUiStore.getState().saveRequestedAt).toBeNull();
            request(11);
            expect(
                useUiStore.getState().saveRequestedAt,
                'a timestamp is the nonce: two requests in a row must not look like one already answered'
            ).toBe(11);
        } finally {
            stop();
        }
    });

    it('delivers nothing once the subscription is disposed, which is what the window closing does', () => {
        installBridge();
        const stop = subscribeSaveRequests(({ requestedAt }) => { writeSaveRequest(requestedAt); });
        stop();
        request(42);
        expect(useUiStore.getState().saveRequestedAt).toBeNull();
    });

    it('answers with a disposer even with no bridge present, so a broken preload is not a crash', () => {
        const stop = subscribeSaveRequests(() => undefined);
        expect(typeof stop).toBe('function');
        stop();
    });

    it('carries a payload the declared event schema accepts, and refuses one it does not', () => {
        const schema = ipcEvents['shell:saveRequested'];
        expect(schema.safeParse({ requestedAt: 1 }).success).toBe(true);
        expect(schema.safeParse({ requestedAt: -1 }).success).toBe(false);
        expect(schema.safeParse({ requestedAt: 1, why: 'stop' }).success, 'the event payload is not strict')
            .toBe(false);
    });
});

/*
 * The two halves of answering it, read off the source: the shell puts Home on screen because the request may arrive
 * on any route, and Home opens the form and clears the request. Either half alone is a request that does nothing.
 */
describe('PANEL-02: both halves of the answer are wired', () => {
    const SHELL = 'src/renderer/src/components/layout/AppShell.tsx';
    const HOME = 'src/renderer/src/features/timer/TimerPage.tsx';
    /** Comments removed, string literals kept: the effect below is identified by what it calls, not by prose. */
    const codeOf = (file: string): string =>
        read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    it('puts Home on screen from the shell, which is mounted on every route', () => {
        const code = codeOf(SHELL);
        expect(code, SHELL + ' no longer reads the save request').toContain('saveRequestedAt');
        expect(code, SHELL + ' reads the request without navigating, so a window left on Settings answers nothing')
            .toMatch(/navigate\(ROUTE_PATHS\.home\)/);
    });

    it('opens the form from Home, clears the request, and puts the date back to today', () => {
        const code = codeOf(HOME);
        const start = code.indexOf('if (saveRequestedAt === null)');
        expect(start, HOME + ' has no effect that answers the save request').toBeGreaterThan(-1);
        const effect = code.slice(start, code.indexOf('}, [saveRequestedAt', start));
        expect(effect.length, 'the effect could not be bounded; teach this test its shape').toBeGreaterThan(0);

        expect(effect, HOME + ' never clears the request, so one request would reopen the form forever')
            .toContain('clearSaveRequest()');
        expect(effect, HOME + ' answers the request without opening the save form').toContain("setDialog('save')");
        expect(
            effect,
            HOME + ' leaves whatever date was selected, so the panel could write the running clock onto yesterday'
        ).toContain('setSelectedDate(today)');
    });

    /*
     * The cost of the two-step, stated: the shell navigates and Home consumes, so the pair has to be ordered
     * correctly. Home is a child of the shell and React runs child effects first, which means a request arriving
     * while Home is already mounted is consumed before the shell's navigate - and a navigate to the route already
     * showing is a no-op. The order is what makes both arrangements end in the same place.
     */
    it('leaves the request pending for a Home that has not mounted yet', () => {
        useUiStore.getState().requestSaveForm(7);
        expect(
            useUiStore.getState().saveRequestedAt,
            'the request is consumed by nothing but Home, so it has to survive until Home is there'
        ).toBe(7);
    });

    it('is mounted once, outside the route table, with the other pushed-event providers', () => {
        const file = 'src/renderer/src/app/App.tsx';
        const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const code = stripCommentsAndStrings(file, read(file)).code;
        expect(code.indexOf('<SaveRequestProvider>'), file + ' does not mount SaveRequestProvider')
            .toBeGreaterThan(-1);
        expect(
            code.indexOf('<SaveRequestProvider>') < code.indexOf('<HashRouter>'),
            'the provider is inside the router, so a route change would tear its subscription down'
        ).toBe(true);
        expect(findAll(source, (node): node is ts.JsxOpeningElement =>
            ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'SaveRequestProvider'))
            .toHaveLength(1);
    });
});

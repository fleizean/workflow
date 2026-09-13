/*
 * RENDERER CR-01, run rather than read.
 *
 * The quit confirm is a pure function of the timer snapshot, and the snapshot is whatever the last timer:tick left
 * in the store. That subscription used to be mounted by TimerPage, so it was disposed on every navigation away
 * from / - and the confirm, which the titlebar raises on all four routes, then answered from a frozen snapshot.
 * The branch that matters is persistFailing: it exists precisely so the dialog stops promising safety while the
 * disk is refusing writes, and off Home it could never be reached.
 *
 * Both arrangements are performed below through the real facade and a real bridge shape. The second test disposes
 * the subscription the way a route change did and shows the confirm promising "Quitting keeps it" over a failing
 * disk - so the first test cannot pass for the wrong reason.
 */

import { afterEach, describe, expect, it } from 'vitest';
/*
 * Imported past the feature index on purpose: tsconfig.node.json has no jsx and no DOM lib, so pulling
 * features/timer/index.ts in would drag TimerPage.tsx into the node program. renderer-structure.test.ts holds
 * TimerProvider.tsx to calling subscribeTimerTicks(setTimerSnapshot), which is the wiring performed below.
 */
import { subscribeTimerTicks } from '@renderer/app/providers/timer-feed';
import { readTimerSnapshot, setTimerSnapshot } from '@renderer/features/timer/state/timer.store';
import { quitDialogFor } from '@renderer/features/shell/quit-dialog';
import { API_BRIDGE_KEY } from '@shared/constants/bridge';
import type { TimerSnapshot } from '@shared/types';

type Listener = (payload: TimerSnapshot) => void;

const listeners = new Set<Listener>();

/** The preload bridge's event half, with the same disposer contract the real one has. */
function installBridge(): void {
    (globalThis as unknown as Record<string, unknown>)[API_BRIDGE_KEY] = {
        on: {
            'timer:tick': (listener: Listener) => {
                listeners.add(listener);
                return (): void => { listeners.delete(listener); };
            }
        }
    };
}

const tick = (fields: Partial<TimerSnapshot>): void => {
    const payload: TimerSnapshot = {
        status: 'running',
        mode: 'work',
        elapsedSeconds: 0,
        restoredFromPreviousLaunch: false,
        persistFailing: false,
        ...fields
    };
    for (const listener of listeners) listener(payload);
};

afterEach(() => {
    listeners.clear();
    delete (globalThis as unknown as Record<string, unknown>)[API_BRIDGE_KEY];
    setTimerSnapshot({
        status: 'idle', mode: 'work', elapsedSeconds: 0,
        restoredFromPreviousLaunch: false, persistFailing: false
    });
});

describe('CR-01: the quit confirm answers from a snapshot the whole app keeps current', () => {
    it('reaches the warning body when the disk starts refusing writes on another screen', () => {
        installBridge();
        const stop = subscribeTimerTicks(setTimerSnapshot);
        try {
            tick({ elapsedSeconds: 7 });
            expect(quitDialogFor(readTimerSnapshot()).body, 'the opening tick did not reach the store')
                .toContain('restores it, paused');

            // The user leaves Home. The subscription is app/providers', so nothing here is torn down - and 45
            // minutes later the disk starts refusing writes.
            tick({ elapsedSeconds: 2700, persistFailing: true });

            const dialog = quitDialogFor(readTimerSnapshot());
            expect(dialog.body, 'the confirm named a time the clock passed 45 minutes ago').toContain('00:45:00');
            expect(dialog.body, 'the confirm promised safety while the disk was refusing writes')
                .toContain('failing to save it');
            expect(dialog.tone).toBe('warning');
        } finally {
            stop();
        }
    });

    it('promises safety over a failing disk once that subscription is disposed (the old arrangement)', () => {
        installBridge();
        const stop = subscribeTimerTicks(setTimerSnapshot);
        tick({ elapsedSeconds: 7 });

        // Exactly what TimerPage unmounting did: the effect returned the bridge disposer.
        stop();
        tick({ elapsedSeconds: 2700, persistFailing: true });

        const dialog = quitDialogFor(readTimerSnapshot());
        expect(
            dialog.body,
            'the disposed subscription still delivered the tick, so this control no longer reproduces CR-01'
        ).toContain('00:00:07');
        expect(dialog.tone, 'the frozen snapshot is what made the safe branch reachable over a failing disk')
            .toBe('info');
        expect(dialog.body).toContain('Quitting keeps it');
    });

    it('is never handed a snapshot the bridge cannot deliver, so a missing bridge is not a crash', () => {
        const stop = subscribeTimerTicks(setTimerSnapshot);
        expect(typeof stop, 'subscribe must answer with a disposer even with no bridge present').toBe('function');
        stop();
    });
});

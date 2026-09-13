// The titlebar's two buttons. Owner decision 2026-09-13: they no longer end in the same place, so each asks for the
// thing it means. Where a hidden window goes - the tray, or the taskbar when there is no tray - is still main's
// decision (IPC-05); the renderer only asks.

import { useCallback, useMemo } from 'react';
import { readTimerSnapshot } from '@renderer/features/timer';
import { invoke } from '@renderer/lib/ipc';
import { once } from '@renderer/lib/once';
import { useUiStore } from '@renderer/store/ui.store';
import { HIDE_NOTICE, quitDialogFor } from '../quit-dialog';

interface ShellControls {
    readonly hide: () => void;
    readonly quit: () => void;
}

export function useShellControls(): ShellControls {
    const report = useCallback((error: unknown): void => {
        const message = error instanceof Error && error.message !== '' ? error.message : 'The window did not respond.';
        useUiStore.getState().pushToast('error', message);
    }, []);

    /*
     * WR-02: the sequence runs at most once at a time. A second click while the first round trip is in flight
     * used to start a second one, whose claim answered "not due" and which hid the window at once - and the first
     * then drew the notice behind a window that was no longer there, with the flag spent. It is a database row,
     * so it never re-arms: the user who most needs the explanation is the one who never gets it.
     */
    const hideOnce = useMemo(() => once(async () => {
        // Claimed before the window goes: a notice raised after it would be behind a window that is not there.
        // A claim that fails is not a reason to refuse to get out of the way, so it counts as not due.
        const claim = await invoke('window:claimHideNotice').catch(() => ({ due: false }));
        if (claim.due) {
            await useUiStore.getState().openDialog(HIDE_NOTICE);
        }
        await invoke('window:hide');
    }), []);
    const hide = useCallback(() => { void hideOnce().catch(report); }, [hideOnce, report]);

    const quit = useCallback(() => {
        void (async () => {
            // Read at the click rather than subscribed to: the titlebar must not re-render on every tick.
            const asked = quitDialogFor(readTimerSnapshot());
            if (await useUiStore.getState().openDialog(asked)) {
                await invoke('app:quit');
            }
        })().catch(report);
    }, [report]);

    return { hide, quit };
}

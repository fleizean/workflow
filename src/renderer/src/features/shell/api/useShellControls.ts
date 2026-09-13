// The titlebar's two buttons. Owner decision 2026-09-13: they no longer end in the same place, so each asks for the
// thing it means. Where a hidden window goes - the tray, or the taskbar when there is no tray - is still main's
// decision (IPC-05); the renderer only asks.

import { useCallback } from 'react';
import { useTimerStore } from '@renderer/features/timer';
import { invoke } from '@renderer/lib/ipc';
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

    const hide = useCallback(() => {
        void (async () => {
            // Claimed before the window goes: a notice raised after it would be behind a window that is not there.
            // A claim that fails is not a reason to refuse to get out of the way, so it counts as not due.
            const claim = await invoke('window:claimHideNotice').catch(() => ({ due: false }));
            if (claim.due) {
                await useUiStore.getState().openDialog(HIDE_NOTICE);
            }
            await invoke('window:hide');
        })().catch(report);
    }, [report]);

    const quit = useCallback(() => {
        void (async () => {
            // Read at the click rather than subscribed to: the titlebar must not re-render on every tick.
            const asked = quitDialogFor(useTimerStore.getState().snapshot);
            if (await useUiStore.getState().openDialog(asked)) {
                await invoke('app:quit');
            }
        })().catch(report);
    }, [report]);

    return { hide, quit };
}

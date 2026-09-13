// The frameless window's own controls. v1.2.1 hid to the tray on both buttons and main still decides that (IPC-05);
// the renderer only asks.

import { useCallback } from 'react';
import { invoke } from '@renderer/lib/ipc';
import { useUiStore } from '@renderer/store/ui.store';

interface WindowControls {
    readonly minimize: () => void;
    readonly close: () => void;
}

export function useWindowControls(): WindowControls {
    const report = useCallback((error: unknown): void => {
        const message = error instanceof Error && error.message !== '' ? error.message : 'The window did not respond.';
        useUiStore.getState().pushToast('error', message);
    }, []);

    return {
        minimize: useCallback(() => { invoke('window:minimize').catch(report); }, [report]),
        close: useCallback(() => { invoke('window:close').catch(report); }, [report])
    };
}

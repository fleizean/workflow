// One subscription for the whole renderer. The disposer is the bridge's own and is idempotent, which is what makes
// StrictMode's double mount and a fast route change safe (IPC-06).

import { useEffect } from 'react';
import { subscribe } from '@renderer/lib/ipc';
import { useTimerStore } from '../state/timer.store';

export function useTimerTicks(): void {
    const setSnapshot = useTimerStore((state) => state.setSnapshot);
    useEffect(() => subscribe('timer:tick', setSnapshot), [setSnapshot]);
}

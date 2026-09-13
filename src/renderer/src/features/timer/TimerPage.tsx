/*
 * The Phase 7 shell of the Home screen. It READS the authoritative clock and nothing more: no start, no pause, no
 * save. TIMER-01..09 build the screen in Phase 8, and a shell that could start a clock it cannot save would be a
 * way to lose tracked time, which is the one thing this milestone is not allowed to do.
 *
 * "Home" is the marker the packaged smoke waits for (src/main/config.ts RENDERER_MARKER_TEXT).
 */

import type { ReactElement } from 'react';
import { formatElapsed } from '@renderer/lib/duration';
import { useTimerSnapshot } from './api/useTimerSnapshot';
import { useTimerTicks } from './api/useTimerTicks';
import { useTimerStore } from './state/timer.store';

export default function TimerPage(): ReactElement {
    const query = useTimerSnapshot();
    useTimerTicks();
    const snapshot = useTimerStore((state) => state.snapshot);

    return (
        <section className="px-6 pt-4 pb-28">
            <h1 className="text-2xl font-bold tracking-tight">Home</h1>
            <p className="mt-6 font-mono text-5xl tabular-nums tracking-tight">
                {formatElapsed(snapshot?.elapsedSeconds ?? 0)}
            </p>
            <p className="mt-2 text-sm text-gray-400">
                {snapshot === null ? 'Reading the clock...' : snapshot.status + ' / ' + snapshot.mode}
            </p>
            {snapshot?.restoredFromPreviousLaunch === true ? (
                <p className="mt-2 text-sm text-amber-400">
                    Time from a previous launch was restored. Phase 8 adds the save-or-discard prompt.
                </p>
            ) : null}
            {query.isError ? <p className="mt-4 text-sm text-red-400">{query.error.message}</p> : null}
        </section>
    );
}

// The timer's opening value: what main says the clock reads right now, including a state restored from a previous
// launch (CORE-05, G3/G4). Every value after this one arrives as a tick.

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import { useTimerStore } from '../state/timer.store';
import type { TimerSnapshot } from '@shared/types';

export const timerSnapshotQuery = {
    queryKey: queryKeys.timerSnapshot,
    queryFn: (): Promise<TimerSnapshot> => invoke('timer:getSnapshot')
};

export function useTimerSnapshot(): UseQueryResult<TimerSnapshot> {
    const query = useQuery(timerSnapshotQuery);

    const setSnapshot = useTimerStore((state) => state.setSnapshot);
    const snapshot = query.data;
    useEffect(() => {
        if (snapshot !== undefined) {
            setSnapshot(snapshot);
        }
    }, [snapshot, setSnapshot]);

    return query;
}

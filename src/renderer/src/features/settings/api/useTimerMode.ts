/*
 * CORE-14/CB-1: a mode change touches the mode and nothing else. v1.2.1's toggle called reset() on both branches
 * (legacy/renderer/timer.js:115 and :126), so tapping it threw away every unsaved second, and then threw a
 * TypeError before it could even repaint.
 *
 * Two writes, because two things mean it: timer.state.mode is what the clock runs in and survives a restart, and
 * settings.pomodoroEnabled is the preference the Settings screen shows. Neither write touches the accumulator, so a
 * failure of the second costs a checkbox and never a second of counted time.
 *
 * It lives in features/settings rather than in features/timer, where it was written, because BOTH screens toggle
 * the mode and the pair has to stay a pair. features/timer already imports features/settings, so this is the end of
 * the arrow that has no cycle in it - and it is why useUpdateSettings below cannot carry pomodoroEnabled: the one
 * key that means two writes is not reachable through the form that writes the other nine.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import { queryKeys } from '@renderer/lib/query-keys';
import type { Settings, TimerMode } from '@shared/types';

/*
 * IN-01 / NT-03: the two writes are still two writes, and a kill between them still leaves the clock in the new
 * mode with the preference in the old one. Removing that needs one `timer:setMode` handler writing both below IPC,
 * which is a contract change and not this pass's to make.
 *
 * What is closed is the half both reviewers actually complained about: the screens never re-reconciled. On a
 * failure the settings read and the timer snapshot are invalidated, so the two toggles go back to the database
 * rather than carrying on rendering a state the app is not in. The error toast QueryProvider's MutationCache
 * raises is unchanged.
 */
export function useSetTimerMode(): UseMutationResult<Settings, Error, TimerMode> {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (mode: TimerMode): Promise<Settings> => {
            await invoke('timer:setMode', { mode });
            return invoke('settings:update', { pomodoroEnabled: mode === 'pomodoro' });
        },
        onError: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
            void queryClient.invalidateQueries({ queryKey: queryKeys.timerSnapshot });
        }
    });
}

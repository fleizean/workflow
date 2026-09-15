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

import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import type { Settings, TimerMode } from '@shared/types';

export function useSetTimerMode(): UseMutationResult<Settings, Error, TimerMode> {
    return useMutation({
        mutationFn: async (mode: TimerMode): Promise<Settings> => {
            await invoke('timer:setMode', { mode });
            return invoke('settings:update', { pomodoroEnabled: mode === 'pomodoro' });
        }
    });
}

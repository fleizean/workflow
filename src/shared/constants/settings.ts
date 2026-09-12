// v1.2.1's settings seeds as typed defaults; zod-free, so the renderer and fresh-install seeding can import it.
import type { Settings } from '@shared/types';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
    dailyTargetSeconds: 28800,
    goalNotification: true,
    excludeWeekendsFromStreak: false,
    pomodoroEnabled: false,
    pomodoroWorkSeconds: 1500,
    pomodoroShortBreakSeconds: 300,
    pomodoroLongBreakSeconds: 900,
    pomodoroSessionsUntilLongBreak: 4,
    pomodoroAutoStartBreaks: true,
    pomodoroAutoStartWork: false
});

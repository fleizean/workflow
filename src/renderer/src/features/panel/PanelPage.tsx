/*
 * PANEL-01..05: the tray panel, as a route in the one document rather than a second page (SPA-01).
 *
 * It answers "where am I" without opening the app, and nothing else. Companies, history, settings, the date picker
 * and the pomodoro cycle are deliberately not here - the panel's value is that it is not the app, and putting the
 * app inside it spends that value. The footer is how everything it does not hold is reached.
 *
 * The ticks arrive on the same subscription Home reads, mounted by app/providers for this document (CR-01). The
 * document ends when the panel window is destroyed on blur, so the subscription ends with the surface and leaks
 * nothing (PANEL-04) - there is no disposer here for anyone to forget.
 *
 * It owns no clock and no date: the elapsed seconds are main's snapshot, the day is the day main's clock named
 * (stats:today), and everything it decides it decides in panel-view.ts where a test can run it.
 */

import type { ReactElement } from 'react';
import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import { useSettings } from '@renderer/features/settings';
import { useWeekTotals } from '@renderer/features/history';
import { streakLabel, useLiveTimerSnapshot, usePauseTimer, useStartTimer, useStreak } from '@renderer/features/timer';
import { useShowMainWindow } from './api/useMainWindow';
import { useTodayProgress } from './api/useTodayProgress';
import PanelFooter from './components/PanelFooter';
import PanelTimerRow from './components/PanelTimerRow';
import ProgressRow, { MET_FILL, TODAY_FILL, WEEK_FILL } from './components/ProgressRow';
import { countedTowardToday, describePanelTimer, describeProgress, weeklyTargetSeconds } from './panel-view';

const PANEL = 'flex h-screen w-full flex-col overflow-hidden font-display ' +
    'bg-background-light dark:bg-background-dark text-slate-900 dark:text-white';
const BARS = 'flex flex-col gap-4 px-4 pt-4';
const STREAK = 'flex items-center gap-2 px-4 pt-4 text-xs text-slate-600 dark:text-slate-300';
const STREAK_GLYPH = "material-symbols-outlined text-base text-orange-500 [font-variation-settings:'FILL'_1]";

export default function PanelPage(): ReactElement {
    const snapshot = useLiveTimerSnapshot();
    const settings = useSettings();
    const today = useTodayProgress();
    const weeks = useWeekTotals();
    const streak = useStreak();

    const start = useStartTimer();
    const pause = usePauseTimer();
    const showMain = useShowMainWindow();

    const timer = describePanelTimer(snapshot);
    const counted = countedTowardToday(snapshot);
    const dailyTargetSeconds = today.data?.dailyTargetSeconds ?? DEFAULT_SETTINGS.dailyTargetSeconds;
    const excludeWeekends = settings.data?.excludeWeekendsFromStreak ?? DEFAULT_SETTINGS.excludeWeekendsFromStreak;

    // The day's own total: what is on disk plus what the clock holds for today and has not written yet (B7).
    const day = describeProgress((today.data?.totalSeconds ?? 0) + counted, dailyTargetSeconds);
    const week = describeProgress(
        (weeks.data?.thisWeekSeconds ?? 0) + counted,
        weeklyTargetSeconds(dailyTargetSeconds, excludeWeekends)
    );

    return (
        <div className={PANEL}>
            <PanelTimerRow
                elapsed={timer.elapsed}
                status={timer.status}
                running={timer.running}
                canToggle={timer.canToggle}
                canSave={timer.canSave}
                note={timer.note}
                warning={timer.warning}
                busy={start.isPending || pause.isPending}
                onToggle={() => { if (timer.running) { pause.mutate(); } else { start.mutate(); } }}
                onSave={() => { showMain.mutate('save'); }}
            />

            <div className={BARS}>
                <ProgressRow
                    label="Today"
                    figures={day.figures}
                    percentLabel={day.percentLabel}
                    barPercent={day.barPercent}
                    fill={day.met ? MET_FILL : TODAY_FILL}
                />
                <ProgressRow
                    label="This week"
                    figures={week.figures}
                    percentLabel={week.percentLabel}
                    barPercent={week.barPercent}
                    fill={week.met ? MET_FILL : WEEK_FILL}
                />
            </div>

            <p className={STREAK}>
                <span className={STREAK_GLYPH}>local_fire_department</span>
                <span className="font-bold">{streakLabel(streak.data?.days ?? 0)}</span>
                <span>in a row</span>
            </p>

            <PanelFooter onOpen={() => { showMain.mutate('open'); }} />
        </div>
    );
}

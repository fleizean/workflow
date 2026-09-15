/*
 * POMO-03/05/06/07/08/09: the cycle, on the same dial the work timer uses.
 *
 * The panel holds no state about the cycle. Every number on it - which interval, how far in, how many pomodoros
 * today, how many before the long break - comes from the snapshot main pushes, and main derives the count from the
 * database on every question (CORE-12). That is why the long break arrives in the right place after a restart
 * without anything here remembering anything.
 *
 * Completion is not this panel's business either: it happens on main's scheduler, writes the session and the
 * pomodoro row in one transaction, and raises the sound and the system notification from main - so it works with
 * the window hidden in the tray, which is the half of it v1.2.1 could never do from a renderer that was not running
 * (POMO-03).
 */

import type { ReactElement } from 'react';
import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import { useSettings } from '@renderer/features/settings';
import {
    useAbortPomodoro, usePausePomodoro, usePomodoroCounts, usePomodoroSnapshot, useSkipBreak, useStartPomodoro
} from '../api/usePomodoro';
import { usePomodoroAutoStart } from '../api/usePomodoroAutoStart';
import { usePomodoroStore } from '../state/pomodoro.store';
import { countsLabel, describePomodoroDial } from '../pomodoro-view';
import PomodoroControls from './PomodoroControls';
import TimerDial from './TimerDial';

const FAILED_CLASS = 'flex items-start gap-3 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 ' +
    'text-left text-sm text-red-200';
const AUTO_CLASS = 'flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-3 ' +
    'text-left text-sm text-slate-200';
const AUTO_ACTION_CLASS = 'shrink-0 rounded-xl bg-primary/20 px-3 py-1.5 text-xs font-bold uppercase ' +
    'tracking-wider text-primary transition hover:bg-primary/30';

const INTERVAL_WORD: Record<'work' | 'shortBreak' | 'longBreak', string> = {
    work: 'the next pomodoro',
    shortBreak: 'the short break',
    longBreak: 'the long break'
};

export default function PomodoroPanel(): ReactElement {
    const query = usePomodoroSnapshot();
    const snapshot = usePomodoroStore((state) => state.snapshot);
    const counts = usePomodoroCounts();
    const settings = useSettings();

    const start = useStartPomodoro();
    const pause = usePausePomodoro();
    const abort = useAbortPomodoro();
    const skip = useSkipBreak();

    const autoStart = usePomodoroAutoStart(
        settings.data?.pomodoroAutoStartBreaks ?? DEFAULT_SETTINGS.pomodoroAutoStartBreaks,
        settings.data?.pomodoroAutoStartWork ?? DEFAULT_SETTINGS.pomodoroAutoStartWork
    );

    if (snapshot === null) {
        return (
            <p className="py-16 text-center text-sm text-slate-400">
                {query.isError ? query.error.message : 'Reading the cycle...'}
            </p>
        );
    }

    const running = snapshot.status === 'running';
    const dial = describePomodoroDial(snapshot, running);

    return (
        <>
            {/*
              * CR-01 made visible. The interval reached its target and the write that would have preserved it threw,
              * so the service is holding the seconds rather than discarding them and has paused on the interval that
              * earned them. Saying so is the whole point: a user whose disk is full must be told, not left with a
              * cycle that silently stopped.
              */}
            {snapshot.recordingFailed ? (
                <p className={FAILED_CLASS}>
                    <span className="material-symbols-outlined text-xl">warning</span>
                    <span>
                        That pomodoro finished but could not be written to the database. Its time is still counted
                        and nothing has been lost - start the cycle again to retry the write.
                    </span>
                </p>
            ) : null}

            {autoStart.pending === null ? null : (
                <div className={AUTO_CLASS}>
                    <span className="material-symbols-outlined text-xl">timer</span>
                    <span className="flex-1">
                        Starting {INTERVAL_WORD[autoStart.pending.interval]} in{' '}
                        {String(Math.max(0, autoStart.pending.secondsLeft))}s.
                    </span>
                    <button type="button" className={AUTO_ACTION_CLASS} onClick={autoStart.cancel}>Cancel</button>
                </div>
            )}

            <TimerDial
                headline={dial.headline}
                exceeded={false}
                digits={dial.digits}
                ringOffset={dial.ringOffset}
                ringColour={dial.ringColour}
                badgeIcon="local_pizza"
                badgeText={dial.badgeText}
                running={running}
                meta={dial.meta}
            />

            <PomodoroControls
                running={running}
                isBreak={dial.isBreak}
                hasProgress={snapshot.elapsedSeconds > 0}
                busy={start.isPending || pause.isPending}
                countsLabel={countsLabel(counts.data?.todayCount ?? 0, counts.data?.thisWeekCount ?? 0)}
                onToggle={() => {
                    autoStart.cancel();
                    if (running) {
                        pause.mutate();
                        return;
                    }
                    start.mutate();
                }}
                onSkipBreak={() => { autoStart.cancel(); skip.mutate(); }}
                onAbort={() => { autoStart.cancel(); abort.mutate(); }}
            />
        </>
    );
}

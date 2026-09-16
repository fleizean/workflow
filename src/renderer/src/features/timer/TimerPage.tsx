/*
 * TIMER-01..09. legacy/pages/index.html's Home screen, over the authoritative clock in main.
 *
 * The screen owns no clock. Every number on it is either a snapshot main pushed (X1) or a row the database holds;
 * what it decides, it decides in timer-view.ts where a test can run it. The one thing it does own is what gets
 * WRITTEN - the duration, the company, the note and the date - and that goes out through `timer:stopAndSave`, the
 * single transaction Phase 5 added because `sessions:create` then `timer:reset` is two invokes and two invokes
 * cannot be atomic (WR-06).
 *
 * The selected date and the pending adjustment are this component's own state on purpose. v1.2.1 reloaded the page
 * on every navigation, so both reset whenever you came back to Home; keeping them in a feature store would make a
 * date picked yesterday afternoon still be selected tomorrow morning, and the timer would then write today's work
 * onto a day the user had forgotten they picked.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useUiStore } from '@renderer/store/ui.store';
import { useCompanies } from '@renderer/features/companies';
import { useSetTimerMode, useSettings } from '@renderer/features/settings';
import { formatElapsed } from '@renderer/lib/duration';
import { formatLocalDate } from '@shared/utils/date';
import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import type { LocalDate } from '@shared/types';
import { useTimerSnapshot } from './api/useTimerSnapshot';
import { useTimerSessions } from './api/useTimerSessions';
import { useStreak } from './api/useStreak';
import { usePauseTimer, useResetTimer, useStartTimer, useStopAndSave } from './api/useTimerCommands';
import type { StopAndSaveValues } from './api/useTimerCommands';
import { useTimerStore } from './state/timer.store';
import { useAttributeSession } from './api/usePomodoro';
import AdjustTimeForm from './components/AdjustTimeForm';
import AttributionForm from './components/AttributionForm';
import type { AttributionAnswer } from './components/AttributionForm';
import DatePickerForm from './components/DatePickerForm';
import HomeHeader from './components/HomeHeader';
import PomodoroPanel from './components/PomodoroPanel';
import RestorePrompt from './components/RestorePrompt';
import SaveSessionForm from './components/SaveSessionForm';
import StatCards from './components/StatCards';
import TimerControls from './components/TimerControls';
import TimerDial from './components/TimerDial';
import { adjustmentLabel, dayTotalOf, describeResetConfirm, describeWorkDial } from './timer-view';
import { pendingAttributions } from './pomodoro-view';

type OpenDialog = 'none' | 'date' | 'adjust' | 'save' | 'restore';

const BANNER_CLASS = 'flex items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 ' +
    'text-left text-sm text-amber-200';
const BANNER_ACTION_CLASS = 'shrink-0 rounded-xl bg-amber-500/20 px-3 py-1.5 text-xs font-bold uppercase ' +
    'tracking-wider text-amber-100 transition hover:bg-amber-500/30';
const FAILING_CLASS = 'flex items-center gap-3 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 ' +
    'text-left text-sm text-red-200';
const ADJUSTED_CLASS = 'text-center text-xs font-semibold text-amber-400';

export default function TimerPage(): ReactElement {
    // The ticks and the opening read are mounted by app/providers, for the whole app (CR-01). The query is named
    // again here only so this screen can show the error state of the call it depends on.
    const snapshotQuery = useTimerSnapshot();
    const snapshot = useTimerStore((state) => state.snapshot);
    const settings = useSettings();
    const sessions = useTimerSessions();
    const companies = useCompanies();
    const streak = useStreak();

    const start = useStartTimer();
    const pause = usePauseTimer();
    const reset = useResetTimer();
    const stopAndSave = useStopAndSave();
    const setMode = useSetTimerMode();
    const attribute = useAttributeSession();

    const pushToast = useUiStore((state) => state.pushToast);
    const openDialog = useUiStore((state) => state.openDialog);

    const today = formatLocalDate(new Date());
    const [selectedDate, setSelectedDate] = useState<LocalDate>(today);
    const [adjustmentSeconds, setAdjustmentSeconds] = useState(0);
    const [dialog, setDialog] = useState<OpenDialog>('none');
    /*
     * POMO-02/POMO-04. The prompt is offered, never forced: saying "not now" sets this and the queue waits until
     * the next visit to Home or the next launch. The rows themselves are untouched either way - they were written
     * in one transaction before this screen was told anything (container.ts recordCompletion), which is why no
     * dismissal path here can lose a second.
     */
    const [attributionDeferred, setAttributionDeferred] = useState(false);

    const elapsedSeconds = snapshot?.elapsedSeconds ?? 0;
    const running = snapshot?.status === 'running';
    const mode = snapshot?.mode ?? 'work';
    const restored = snapshot?.restoredFromPreviousLaunch === true && elapsedSeconds > 0;

    // IN-03/WR-06: main counts on today. A dial for any other day is what that day's rows say, and nothing else.
    const showingToday = selectedDate === today;

    const dial = describeWorkDial({
        dailyTargetSeconds: settings.data?.dailyTargetSeconds ?? DEFAULT_SETTINGS.dailyTargetSeconds,
        loggedSeconds: dayTotalOf(sessions.data ?? [], selectedDate),
        elapsedSeconds,
        adjustmentSeconds,
        running,
        // Only ever used to NAME the clock time the target would be reached at; never to measure one.
        nowMs: Date.now(),
        countedOnSelectedDay: showingToday
    });

    /*
     * WR-03: a correction made on the work dial is not on screen in pomodoro mode - the Adjust dialog is gone and
     * the pill under the ring goes with it - but this component does not unmount on a mode change, so the pending
     * value survived it invisibly, and the restore banner's Discard then named a number nobody could see.
     */
    useEffect(() => { setAdjustmentSeconds(0); }, [mode]);

    /*
     * The restore prompt is raised once per mount, when the flag first arrives. It is not raised again if the user
     * says "not now" - the banner below carries the offer from then on, and the next launch asks again.
     */
    const restoreAsked = useRef(false);
    useEffect(() => {
        if (restored && !restoreAsked.current) {
            restoreAsked.current = true;
            setDialog('restore');
        }
    }, [restored]);

    /*
     * TIMER-05's visible half. The sound and the system notification are main's - it owns the once-per-local-day
     * decision in app_state (goal.service.ts), which is what B1's localStorage flag and in-memory flag could not do
     * between them. This only congratulates, and only on the transition, so re-entering Home on a day already met
     * says nothing.
     */
    const goalWas = useRef<boolean | null>(null);
    const ready = settings.isSuccess && sessions.isSuccess;
    useEffect(() => {
        /*
         * WR-06: the effect fires on a false-to-true transition, and `goalMet` is measured against whatever day the
         * header's picker last chose. Looking at Yesterday to check what was logged used to raise a success dialog
         * saying "You have worked your target for today", and choosing Today again re-armed it. A date change is
         * not a transition, so the remembered answer goes with the date.
         */
        if (!showingToday) {
            goalWas.current = null;
            return;
        }
        if (!ready) {
            return;
        }
        const was = goalWas.current;
        goalWas.current = dial.goalMet;
        if (was === false && dial.goalMet) {
            void openDialog({
                tone: 'success',
                icon: 'emoji_events',
                title: 'Daily goal reached',
                body: 'You have worked your target for today.',
                dismissLabel: 'Great'
            });
        }
    }, [showingToday, ready, dial.goalMet, openDialog]);

    const close = (): void => { setDialog('none'); };

    const toggleRunning = (): void => {
        if (running) {
            pause.mutate();
            return;
        }
        start.mutate();
    };

    /*
     * The one destructive path on this screen, and it says what it costs before it happens. Nothing else discards:
     * dismissing a dialog, changing route, hiding the window and quitting all leave every counted second where it
     * is, and quitting restores it paused on the next launch (features/shell/quit-dialog.ts says so too).
     */
    const confirmReset = (): void => {
        // WR-03: the accumulator is what reset discards, and the pending correction has never touched it.
        void openDialog(describeResetConfirm(elapsedSeconds)).then((confirmed) => {
            if (confirmed) {
                reset.mutate(undefined, {
                    onSuccess: () => {
                        setAdjustmentSeconds(0);
                        pushToast('success', 'Timer has been reset.');
                    }
                });
            }
        });
    };

    const save = (values: StopAndSaveValues): void => {
        stopAndSave.mutate(values, {
            onSuccess: () => {
                setAdjustmentSeconds(0);
                setDialog('none');
                pushToast('success', 'Session saved successfully');
            }
        });
    };

    const pending = adjustmentLabel(adjustmentSeconds);
    const unattributed = pendingAttributions(sessions.data ?? []);
    const attributing = attributionDeferred || dialog !== 'none' ? undefined : unattributed[0];

    /*
     * An ordinary session update, because the session already exists. The note is a string and never null: a null
     * note is what marks a row as never having been asked, so writing one back would re-arm the prompt the user
     * just answered (see ANSWERED_WITH_NO_NOTE).
     */
    const saveAttribution = (session: typeof unattributed[number], answer: AttributionAnswer): void => {
        attribute.mutate({
            id: session.id,
            name: session.name,
            durationSeconds: session.durationSeconds,
            date: session.date,
            companyId: answer.companyId,
            note: answer.note
        }, {
            onSuccess: () => { pushToast('success', 'Pomodoro attributed'); }
        });
    };

    return (
        <div className="flex flex-col">
            <HomeHeader
                date={selectedDate}
                mode={mode}
                onPickDate={() => { setDialog('date'); }}
                onToggleMode={() => { setMode.mutate(mode === 'pomodoro' ? 'work' : 'pomodoro'); }}
            />

            <div className="flex flex-1 flex-col gap-4 px-6 pt-4 pb-32">
                <StatCards
                    dailyTargetSeconds={settings.data?.dailyTargetSeconds ?? DEFAULT_SETTINGS.dailyTargetSeconds}
                    loggedSeconds={dayTotalOf(sessions.data ?? [], selectedDate)}
                    streakDays={streak.data?.days ?? 0}
                />

                {snapshot?.persistFailing === true ? (
                    <p className={FAILING_CLASS}>
                        <span className="material-symbols-outlined text-xl">warning</span>
                        Workflow is counting but cannot write to the database. Save this session now - a restart
                        would lose it.
                    </p>
                ) : null}

                {/*
                  * Counted work-timer seconds that are not on this screen are seconds the user cannot see. That is
                  * true after a restore, and it is true in pomodoro mode, where the dial shows the cycle instead -
                  * so the banner covers both rather than only the one it was written for.
                  */}
                {elapsedSeconds > 0 && (restored || mode === 'pomodoro') ? (
                    <div className={BANNER_CLASS}>
                        <span className="material-symbols-outlined text-xl">history_toggle_off</span>
                        <span className="flex-1">
                            {restored
                                ? formatElapsed(elapsedSeconds) + ' was counted before Workflow last closed, and is' +
                                    ' waiting to be saved or discarded.'
                                : formatElapsed(elapsedSeconds) + ' is still held on the work timer, paused while' +
                                    ' the cycle runs. It is not lost.'}
                        </span>
                        <button
                            type="button"
                            className={BANNER_ACTION_CLASS}
                            onClick={() => { setDialog('restore'); }}
                        >
                            Decide
                        </button>
                    </div>
                ) : null}

                {/*
                  * One screen, two clocks, and at most one of them counts: starting either pauses the other, and
                  * that rule is enforced in the composition root rather than here (container.ts `exclusive`).
                  * Switching mode moves what is on screen and never touches what has been counted - CORE-14, and
                  * the whole of CB-1, where v1.2.1's toggle called reset() on both branches and threw away every
                  * unsaved second with one tap.
                  */}
                {mode === 'pomodoro' ? <PomodoroPanel /> : (
                    <>
                        <TimerDial
                            headline={dial.headline}
                            exceeded={dial.exceeded}
                            digits={dial.digits}
                            ringOffset={dial.ringOffset}
                            ringColour={dial.ringTone}
                            badgeIcon={null}
                            badgeText="Focused"
                            running={running}
                            meta={dial.meta}
                        />

                        {pending === null ? null : <p className={ADJUSTED_CLASS}>{pending}</p>}

                        <TimerControls
                            running={running}
                            hasCountedTime={dial.savableSeconds > 0}
                            busy={start.isPending || pause.isPending}
                            onAdjust={() => { setDialog('adjust'); }}
                            onToggle={toggleRunning}
                            onSave={() => { setDialog('save'); }}
                            onReset={confirmReset}
                        />
                    </>
                )}

                {snapshotQuery.isError ? (
                    <p className="text-sm text-red-400">{snapshotQuery.error.message}</p>
                ) : null}
            </div>

            {dialog === 'date' ? (
                <DatePickerForm
                    date={selectedDate}
                    today={today}
                    onPick={(picked) => { setSelectedDate(picked); setDialog('none'); }}
                    onDismiss={close}
                />
            ) : null}

            {dialog === 'adjust' ? (
                <AdjustTimeForm
                    elapsedSeconds={elapsedSeconds}
                    adjustmentSeconds={adjustmentSeconds}
                    onChange={setAdjustmentSeconds}
                    onDismiss={close}
                />
            ) : null}

            {dialog === 'save' ? (
                <SaveSessionForm
                    countedSeconds={dial.savableSeconds}
                    date={selectedDate}
                    today={today}
                    companies={companies.data ?? []}
                    busy={stopAndSave.isPending}
                    onSubmit={save}
                    onInvalid={(reason) => { pushToast('warning', reason); }}
                    onDismiss={close}
                />
            ) : null}

            {dialog === 'restore' ? (
                <RestorePrompt
                    countedSeconds={elapsedSeconds}
                    onSave={() => { setDialog('save'); }}
                    onDiscard={() => { setDialog('none'); confirmReset(); }}
                    onDismiss={close}
                />
            ) : null}

            {attributing === undefined ? null : (
                <AttributionForm
                    key={String(attributing.id)}
                    session={attributing}
                    remaining={unattributed.length - 1}
                    companies={companies.data ?? []}
                    busy={attribute.isPending}
                    onSubmit={(answer) => { saveAttribution(attributing, answer); }}
                    onInvalid={(reason) => { pushToast('warning', reason); }}
                    onLater={() => { setAttributionDeferred(true); }}
                />
            )}
        </div>
    );
}

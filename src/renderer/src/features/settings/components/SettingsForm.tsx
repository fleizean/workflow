/*
 * SET-01..05: the form half of legacy/pages/settings.html, section for section and class for class, minus the
 * Timesheet Integration block the owner removed with the Google Sheets export (criterion 6).
 *
 * The draft is seeded once at mount and is TEXT rather than numbers: an empty box is not a zero. Nothing is written
 * until Save - except the pomodoro toggle, which is a mode change as well as a preference. v1.2.1's toggle also
 * saved, then raised a "Settings saved successfully!" modal over a switch the user had just watched move
 * (criterion 4); the switch is the feedback.
 */

import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { NUMBER_FIELDS, draftFrom, formatTargetClock, reviewDraft } from '../settings-view';
import type { DraftReview, SettingsDraft } from '../settings-view';
import DailyTargetForm from './DailyTargetForm';
import NumberSettingCard from './NumberSettingCard';
import SettingsToggle from './SettingsToggle';
import type { Settings } from '@shared/types';

const SECTION_CLASS = 'mt-6 mb-2';
const SECTION_TITLE_CLASS = 'text-slate-500 dark:text-slate-400 text-xs font-semibold uppercase tracking-wider ' +
    'px-1 mb-2';
const LIST_CLASS = 'bg-white dark:bg-surface-dark rounded-2xl overflow-hidden shadow-xs border border-black/5 ' +
    'dark:border-white/5 divide-y divide-slate-100 dark:divide-white/5';
const CARD_CLASS = 'bg-white dark:bg-surface-dark rounded-2xl p-4 shadow-xs border border-black/5 ' +
    'dark:border-white/5';
const TARGET_HEAD_CLASS = 'flex justify-between items-center mb-2';
const TARGET_LABEL_CLASS = 'text-slate-900 dark:text-white text-base font-medium';
const TARGET_BUTTON_CLASS = 'block w-full rounded-xl border-none bg-slate-100 dark:bg-[#233c48] text-slate-900 ' +
    'dark:text-white focus:ring-2 focus:ring-primary/50 h-14 px-4 text-lg font-medium shadow-inner flex ' +
    'items-center justify-between';
const HINT_CLASS = 'text-slate-500 dark:text-[#92b7c9] text-xs mt-2 pl-1';
const ERROR_CLASS = 'text-red-600 dark:text-red-400 text-xs mt-2 pl-1';
const CHECK_ROW_CLASS = 'flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-slate-50 ' +
    'dark:hover:bg-white/5 transition-colors';
const CHECKBOX_CLASS = 'w-4 h-4 rounded-sm border-gray-600 text-primary focus:ring-primary/50 focus:ring-2 ' +
    'bg-slate-100 dark:bg-[#233c48]';
const CHECK_TITLE_CLASS = 'text-sm text-slate-900 dark:text-white font-medium';
const CHECK_CAPTION_CLASS = 'block text-xs text-slate-500 dark:text-[#92b7c9]';
const SAVE_CLASS = 'w-full bg-primary hover:bg-primary/90 text-white font-bold h-14 rounded-xl flex items-center ' +
    'justify-center gap-2 transition-transform active:scale-[0.98] shadow-lg shadow-primary/30 ' +
    'disabled:opacity-50';

interface SettingsFormProps {
    /** What the database holds right now: the draft is compared against it, so a refetch cannot be argued with. */
    readonly stored: Settings;
    readonly pomodoroEnabled: boolean;
    readonly busy: boolean;
    readonly onTogglePomodoro: (next: boolean) => void;
    /** The whole review, refusals included: the caller owns the toast queue, this owns the messages on the fields. */
    readonly onSubmit: (review: DraftReview) => void;
}

export default function SettingsForm(props: SettingsFormProps): ReactElement {
    const { stored, pomodoroEnabled, busy, onTogglePomodoro, onSubmit } = props;
    const [draft, setDraft] = useState<SettingsDraft>(() => draftFrom(stored));
    const [review, setReview] = useState<DraftReview | null>(null);
    const [picking, setPicking] = useState(false);
    const targetId = useId();

    const errors = review?.errors ?? {};

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        const next = reviewDraft(draft, stored);
        setReview(next);
        onSubmit(next);
    };

    /*
     * noValidate (WR-01). NumberSettingCard carries min/max and a number input's default step of 1, so Chromium
     * refused the submit for exactly the two refusal classes this screen exists to explain - out of range, and not
     * a whole number. reviewDraft never ran, the hint never turned red and the "Nothing was saved" toast never
     * appeared; the user got a bubble instead. The attributes stay because they still state the real bounds.
     */
    return (
        <form onSubmit={submit} noValidate>
            <div className={SECTION_CLASS}>
                <h2 className={SECTION_TITLE_CLASS}>Work Preferences</h2>
                <div className="flex flex-col gap-3">
                    <div className={CARD_CLASS}>
                        <div className={TARGET_HEAD_CLASS}>
                            <label htmlFor={targetId} className={TARGET_LABEL_CLASS}>Daily Target</label>
                            <span className="material-symbols-outlined text-primary">schedule</span>
                        </div>
                        <button
                            id={targetId}
                            type="button"
                            className={TARGET_BUTTON_CLASS}
                            onClick={() => { setPicking(true); }}
                        >
                            <span>{formatTargetClock(draft.dailyTargetSeconds)}</span>
                            <span className="material-symbols-outlined text-slate-400">schedule</span>
                        </button>
                        <p className={errors.dailyTargetSeconds === undefined ? HINT_CLASS : ERROR_CLASS}>
                            {errors.dailyTargetSeconds ?? 'Standard 8-hour work day is default.'}
                        </p>
                    </div>

                    <SettingsToggle
                        variant="card"
                        icon="event_busy"
                        tint="orange"
                        title="Exclude Weekends"
                        caption="Only count Mon-Fri for streak"
                        checked={draft.excludeWeekendsFromStreak}
                        onChange={(next) => { setDraft({ ...draft, excludeWeekendsFromStreak: next }); }}
                    />
                </div>
            </div>

            <div className={SECTION_CLASS}>
                <h2 className={SECTION_TITLE_CLASS}>Notifications</h2>
                <div className={LIST_CLASS}>
                    {/*
                      * v1.2.1 read this one back with querySelectorAll('input[type="checkbox"]')[0] because the
                      * element had no id at all - so it was whichever checkbox the markup happened to put first.
                      */}
                    <SettingsToggle
                        variant="row"
                        icon="flag"
                        tint="blue"
                        title="Goal Reached"
                        caption="Sound and a notification when the daily target is met"
                        checked={draft.goalNotification}
                        onChange={(next) => { setDraft({ ...draft, goalNotification: next }); }}
                    />
                </div>
            </div>

            <div className={SECTION_CLASS}>
                <h2 className={SECTION_TITLE_CLASS}>Pomodoro Timer 🍅</h2>
                <div className={LIST_CLASS}>
                    <SettingsToggle
                        variant="row"
                        icon="timer"
                        tint="red"
                        title="Enable Pomodoro Mode"
                        caption="Use 25/5 work/break intervals"
                        checked={pomodoroEnabled}
                        onChange={onTogglePomodoro}
                    />
                </div>

                {pomodoroEnabled ? (
                    <div className="mt-3 space-y-3">
                        {NUMBER_FIELDS.map((field) => (
                            <NumberSettingCard
                                key={field.key}
                                field={field}
                                value={draft.numbers[field.key]}
                                error={errors[field.key]}
                                onChange={(next) => {
                                    setDraft({ ...draft, numbers: { ...draft.numbers, [field.key]: next } });
                                }}
                            />
                        ))}

                        <div className={CARD_CLASS}>
                            <div className="space-y-3">
                                <label className={CHECK_ROW_CLASS}>
                                    <input
                                        type="checkbox"
                                        className={CHECKBOX_CLASS}
                                        checked={draft.pomodoroAutoStartBreaks}
                                        onChange={(event) => {
                                            setDraft({ ...draft, pomodoroAutoStartBreaks: event.target.checked });
                                        }}
                                    />
                                    <span className="flex-1">
                                        <span className={CHECK_TITLE_CLASS}>Auto-start Breaks</span>
                                        <span className={CHECK_CAPTION_CLASS}>
                                            Automatically start break after work session
                                        </span>
                                    </span>
                                </label>
                                <label className={CHECK_ROW_CLASS}>
                                    <input
                                        type="checkbox"
                                        className={CHECKBOX_CLASS}
                                        checked={draft.pomodoroAutoStartWork}
                                        onChange={(event) => {
                                            setDraft({ ...draft, pomodoroAutoStartWork: event.target.checked });
                                        }}
                                    />
                                    <span className="flex-1">
                                        <span className={CHECK_TITLE_CLASS}>Auto-start Work</span>
                                        <span className={CHECK_CAPTION_CLASS}>
                                            Automatically start work after break
                                        </span>
                                    </span>
                                </label>
                            </div>
                        </div>
                    </div>
                ) : null}
            </div>

            <div className="mt-6 mb-4">
                <button type="submit" disabled={busy} className={SAVE_CLASS}>
                    <span className="material-symbols-outlined">save</span>
                    Save Changes
                </button>
            </div>

            {picking ? (
                <DailyTargetForm
                    seconds={draft.dailyTargetSeconds}
                    onApply={(seconds) => {
                        setDraft({ ...draft, dailyTargetSeconds: seconds });
                        setPicking(false);
                    }}
                    onDismiss={() => { setPicking(false); }}
                />
            ) : null}
        </form>
    );
}

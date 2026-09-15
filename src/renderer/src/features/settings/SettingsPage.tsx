/*
 * SET-01..05. legacy/pages/settings.html's screen, over the settings service that refuses rather than clamps.
 *
 * Three things it does differently from v1.2.1, each because v1.2.1 was wrong rather than because this is nicer:
 *  - the pomodoro toggle raises no dialog. It saved everything and then announced it, over a switch the user had
 *    just watched move (criterion 4);
 *  - the delete-all button is reached by an identifier. legacy/pages/settings.html:659 found it with
 *    document.querySelector('.mt-8.mb-8 button'), so a spacing tweak detached the handler from the one
 *    irreversible action in the app - or attached it to whatever button a later edit put first inside those
 *    margins;
 *  - the delete reports how many sessions went, because the channel says and "Success!" does not.
 */

import type { ReactElement } from 'react';
import ScreenHeader from '@renderer/components/layout/ScreenHeader';
import { ROUTE_PATHS } from '@renderer/lib/routes';
import { useUiStore } from '@renderer/store/ui.store';
import { useSettings } from './api/useSettings';
import { useDeleteAllSessions, useUpdateSettings } from './api/useSettingsMutations';
import { useSetTimerMode } from './api/useTimerMode';
import SettingsForm from './components/SettingsForm';
import {
    ABOUT, DESTRUCTIVE_ACTION_ID, RESET_ALL_CONFIRM, describeDeleteAll, hasChanges, isRefused
} from './settings-view';
import type { DraftReview } from './settings-view';

const SECTION_CLASS = 'mt-6 mb-2';
const SECTION_TITLE_CLASS = 'text-slate-500 dark:text-slate-400 text-xs font-semibold uppercase tracking-wider ' +
    'px-1 mb-2';
const PANEL_CLASS = 'bg-white dark:bg-surface-dark rounded-2xl overflow-hidden shadow-xs border border-black/5 ' +
    'dark:border-white/5';
const ROW_CLASS = 'w-full flex items-center gap-4 px-4 py-4 justify-between hover:bg-slate-50 ' +
    'dark:hover:bg-white/5 transition-colors text-left';
const ROW_ICON_CLASS = 'flex items-center justify-center w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-700/50 ' +
    'text-slate-600 dark:text-slate-300';
const ROW_TITLE_CLASS = 'text-slate-900 dark:text-white text-base font-medium leading-normal';
const DANGER_CLASS = 'w-full bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 font-medium py-4 ' +
    'rounded-2xl border border-red-200 dark:border-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/20 ' +
    'transition-colors flex items-center justify-center gap-2 disabled:opacity-50';

export default function SettingsPage(): ReactElement {
    const settings = useSettings();
    const update = useUpdateSettings();
    const setMode = useSetTimerMode();
    const deleteAll = useDeleteAllSessions();
    const pushToast = useUiStore((state) => state.pushToast);
    const openDialog = useUiStore((state) => state.openDialog);

    /*
     * The service refuses a whole patch rather than writing part of one, so a refused form writes nothing and says
     * where to look. The messages themselves are on the fields; this is the one line that says the Save did not
     * happen, because a Save button that appears to do nothing is the worst of the three answers.
     */
    const save = (review: DraftReview): void => {
        if (isRefused(review)) {
            pushToast('warning', 'Nothing was saved. Two of these settings have limits - see the fields below.');
            return;
        }
        if (!hasChanges(review)) {
            pushToast('info', 'No changes to save.');
            return;
        }
        update.mutate(review.patch, { onSuccess: () => { pushToast('success', 'Settings saved'); } });
    };

    const resetAllData = (): void => {
        void openDialog(RESET_ALL_CONFIRM).then((confirmed) => {
            if (!confirmed) {
                return;
            }
            deleteAll.mutate(undefined, {
                onSuccess: (result) => {
                    pushToast(
                        result.deletedSessionCount === 0 ? 'info' : 'success',
                        describeDeleteAll(result.deletedSessionCount)
                    );
                }
            });
        });
    };

    return (
        <div className="flex flex-col">
            <ScreenHeader title="Settings" backTo={ROUTE_PATHS.home} />
            <div className="px-4 pt-2 pb-32">
                {settings.isPending ? <p className="mt-4 text-sm text-slate-400">Loading...</p> : null}
                {settings.isError ? <p className="mt-4 text-sm text-red-400">{settings.error.message}</p> : null}
                {settings.isSuccess ? (
                    <SettingsForm
                        stored={settings.data}
                        pomodoroEnabled={settings.data.pomodoroEnabled}
                        busy={update.isPending}
                        onTogglePomodoro={(next) => { setMode.mutate(next ? 'pomodoro' : 'work'); }}
                        onSubmit={save}
                    />
                ) : null}

                <div className={SECTION_CLASS}>
                    <h2 className={SECTION_TITLE_CLASS}>General</h2>
                    <div className={PANEL_CLASS}>
                        <button type="button" className={ROW_CLASS} onClick={() => { void openDialog(ABOUT); }}>
                            <span className="flex items-center gap-3">
                                <span className={ROW_ICON_CLASS}>
                                    <span className="material-symbols-outlined text-[20px]">info</span>
                                </span>
                                <span className={ROW_TITLE_CLASS}>About</span>
                            </span>
                            <span className="material-symbols-outlined text-slate-400 text-[24px]">chevron_right</span>
                        </button>
                    </div>
                </div>

                <div className="mt-8 mb-8">
                    <button
                        type="button"
                        data-testid={DESTRUCTIVE_ACTION_ID}
                        disabled={deleteAll.isPending}
                        className={DANGER_CLASS}
                        onClick={resetAllData}
                    >
                        <span className="material-symbols-outlined text-[20px]">delete</span>
                        Reset All Data
                    </button>
                </div>
            </div>
        </div>
    );
}

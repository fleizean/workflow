/*
 * TIMER-07 (G3/G4). A launch that finds counted time restores the clock PAUSED and sets
 * restoredFromPreviousLaunch; this is what consumes that flag.
 *
 * v1.2.1 did the opposite twice over: it read `elapsed` out of localStorage, added every wall-clock second since
 * `lastUpdated` if the timer had been running (legacy/pages/index.html:817-825 - B12, which credited a weekend),
 * then called `timer.start()` so the app came back counting without being asked.
 *
 * Only one of the three answers is destructive:
 *  - Save it opens the ordinary save dialog;
 *  - Not now closes this and leaves every second counted. So does Escape, a backdrop click, navigating away and
 *    quitting - the banner on Home keeps offering it. Nothing dismissive discards anything;
 *  - Discard is a second, destructive confirm that names the amount, and it is the only path that throws it away.
 */

import { useId } from 'react';
import type { ReactElement } from 'react';
import Modal from '@renderer/components/ui/Modal';
import { formatElapsed } from '@renderer/lib/duration';

const TITLE_BLOCK_CLASS = 'flex flex-col items-center justify-center text-center pb-2';
const BADGE_CLASS = 'w-14 h-14 rounded-full bg-linear-to-tr/srgb from-amber-900/50 to-amber-500/20 flex ' +
    'items-center justify-center mb-4 shadow-inner ring-1 ring-white/10';
const TITLE_CLASS = 'text-2xl font-bold text-white tracking-tight';
const LEAD_CLASS = 'text-sm text-gray-400 mt-2 font-medium';
const AMOUNT_CLASS = 'bg-white/5 rounded-2xl p-4 border border-white/10 flex items-center justify-between';
const SAVE_CLASS = 'w-full mt-4 py-4 bg-linear-to-br/srgb from-blue-500 to-blue-600 hover:from-blue-400 ' +
    'hover:to-blue-500 text-white font-semibold rounded-2xl active:scale-95 transition-all duration-200 ' +
    'shadow-lg shadow-blue-500/20';
const LATER_CLASS = 'w-full mt-3 py-4 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white font-semibold ' +
    'rounded-2xl active:scale-95 transition-all duration-200 border border-white/5';
const DISCARD_CLASS = 'w-full mt-3 py-3 text-red-400 hover:text-red-300 font-semibold rounded-2xl ' +
    'active:scale-95 transition-all duration-200';

interface RestorePromptProps {
    readonly countedSeconds: number;
    readonly onSave: () => void;
    readonly onDiscard: () => void;
    readonly onDismiss: () => void;
}

export default function RestorePrompt(props: RestorePromptProps): ReactElement {
    const titleId = useId();

    return (
        <Modal
            labelledBy={titleId}
            onDismiss={props.onDismiss}
            header={(
                <div className={TITLE_BLOCK_CLASS}>
                    <div className={BADGE_CLASS}>
                        <span className="material-symbols-outlined text-amber-400 text-3xl">history_toggle_off</span>
                    </div>
                    <h2 id={titleId} className={TITLE_CLASS}>Time from last time</h2>
                    <p className={LEAD_CLASS}>
                        The timer was counting when Workflow last closed. It has been restored paused - nothing was
                        added for the time the app was shut.
                    </p>
                </div>
            )}
        >
            <div className={AMOUNT_CLASS}>
                <span className="text-sm font-medium text-gray-400">Counted, not saved</span>
                <span className="text-lg font-bold text-primary">{formatElapsed(props.countedSeconds)}</span>
            </div>

            <button type="button" autoFocus className={SAVE_CLASS} onClick={props.onSave}>Save it</button>
            <button type="button" className={LATER_CLASS} onClick={props.onDismiss}>Not now - keep counting it</button>
            <button type="button" className={DISCARD_CLASS} onClick={props.onDiscard}>Discard it</button>
        </Modal>
    );
}

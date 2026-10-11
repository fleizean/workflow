// PANEL-01: the way to the app. Everything the panel does not hold - companies, history, settings, the date
// picker, the pomodoro cycle - is behind this one button, which is why the panel does not need to hold them.

import type { ReactElement } from 'react';

const FOOTER = 'mt-auto border-t border-slate-200 dark:border-slate-800';
const BUTTON = 'flex w-full items-center justify-center gap-2 px-4 py-3 text-[11px] font-bold uppercase ' +
    'tracking-wider text-slate-600 transition-colors hover:bg-slate-100 hover:text-primary ' +
    'dark:text-slate-300 dark:hover:bg-surface-dark dark:hover:text-primary';

export default function PanelFooter({ onOpen }: { readonly onOpen: () => void }): ReactElement {
    return (
        <div className={FOOTER}>
            <button type="button" className={BUTTON} onClick={onOpen}>
                <span className="material-symbols-outlined text-base">open_in_full</span>
                Open Workflow
            </button>
        </div>
    );
}

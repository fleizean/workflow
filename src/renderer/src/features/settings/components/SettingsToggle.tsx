/*
 * The 51x31 switch legacy/pages/settings.html drew four times, as one component.
 *
 * Two changes to its markup, both so the control is honest about itself: the whole row is the <label>, so clicking
 * the text toggles the switch and the pointer cursor and hover highlight v1.2.1 drew are true rather than
 * decorative; and the checked state is written `peer-checked:` rather than `has-[:checked]:`, because that needs
 * the input to be the switch's own sibling.
 *
 * Each tint is a whole class string. Built as `bg-${tint}-100` it would be a name Tailwind's scanner never sees,
 * and the circle would have no colour at all (C3).
 */

import type { ReactElement } from 'react';

export type ToggleTint = 'orange' | 'blue' | 'red';

const CIRCLE_CLASS: Record<ToggleTint, string> = {
    orange: 'flex items-center justify-center w-8 h-8 rounded-full bg-orange-100 dark:bg-orange-500/20 ' +
        'text-orange-600 dark:text-orange-400',
    blue: 'flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-500/20 ' +
        'text-blue-600 dark:text-blue-400',
    red: 'flex items-center justify-center w-8 h-8 rounded-full bg-red-100 dark:bg-red-500/20 ' +
        'text-red-600 dark:text-red-400'
};

const ROW_CLASS: Record<'card' | 'row', string> = {
    card: 'flex items-center gap-4 justify-between cursor-pointer bg-white dark:bg-surface-dark rounded-2xl p-4 ' +
        'shadow-xs border border-black/5 dark:border-white/5 transition-colors',
    row: 'flex items-center gap-4 justify-between cursor-pointer px-4 py-4 hover:bg-slate-50 ' +
        'dark:hover:bg-white/5 transition-colors'
};

const TITLE_CLASS = 'text-slate-900 dark:text-white text-base font-medium leading-normal';
const CAPTION_CLASS = 'text-slate-500 dark:text-[#92b7c9] text-xs';
const SWITCH_CLASS = 'relative flex h-[31px] w-[51px] shrink-0 items-center rounded-full border-none ' +
    'bg-slate-200 dark:bg-[#233c48] p-0.5 peer-checked:justify-end peer-checked:bg-primary ' +
    'transition-colors duration-200';
const KNOB_CLASS = 'h-[27px] w-[27px] rounded-full bg-white shadow-xs transform transition-transform duration-200';

interface SettingsToggleProps {
    readonly variant: 'card' | 'row';
    readonly icon: string;
    readonly tint: ToggleTint;
    readonly title: string;
    readonly caption?: string;
    readonly checked: boolean;
    readonly onChange: (next: boolean) => void;
}

export default function SettingsToggle(props: SettingsToggleProps): ReactElement {
    const { variant, icon, tint, title, caption, checked, onChange } = props;
    return (
        <label className={ROW_CLASS[variant]}>
            <span className="flex items-center gap-3">
                <span className={CIRCLE_CLASS[tint]}>
                    <span className="material-symbols-outlined text-[20px]">{icon}</span>
                </span>
                <span className="flex flex-col justify-center">
                    <span className={TITLE_CLASS}>{title}</span>
                    {caption === undefined ? null : <span className={CAPTION_CLASS}>{caption}</span>}
                </span>
            </span>
            <input
                type="checkbox"
                className="peer sr-only"
                checked={checked}
                onChange={(event) => { onChange(event.target.checked); }}
            />
            <span className={SWITCH_CLASS}>
                <span className={KNOB_CLASS} />
            </span>
        </label>
    );
}

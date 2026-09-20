/*
 * Which of the bundled notification sounds to play, with a button to hear it. Only the sounds the app ships are
 * offered (SOUND_CHOICES) - there is no way to point it at a file. Choosing one plays it straight away, and the
 * play button repeats it; both go through the same renderer-side element the real notification uses, so what is
 * heard here is exactly what will be heard later. Nothing is stored until Save, like every other field.
 */

import { useId } from 'react';
import type { ReactElement } from 'react';
import { playSound } from '@renderer/app/providers';
import { SOUND_CHOICES } from '@shared/constants/settings';
import type { SoundChoice } from '@shared/types';

const ROW_CLASS = 'flex items-center gap-4 justify-between px-4 py-4';
const TITLE_CLASS = 'text-slate-900 dark:text-white text-base font-medium leading-normal';
const CAPTION_CLASS = 'text-slate-500 dark:text-[#92b7c9] text-xs';
const SELECT_CLASS = 'rounded-xl border-none bg-slate-100 dark:bg-[#233c48] text-slate-900 dark:text-white ' +
    'focus:ring-2 focus:ring-primary/50 h-10 pl-3 pr-8 text-sm font-medium disabled:opacity-50';
const PLAY_CLASS = 'flex items-center justify-center w-10 h-10 rounded-full bg-slate-100 dark:bg-[#233c48] ' +
    'text-primary hover:bg-slate-200 dark:hover:bg-white/10 transition-colors disabled:opacity-50';

interface SoundPickerProps {
    readonly value: SoundChoice;
    /** Off greys the picker out: there is nothing to choose between while nothing plays. */
    readonly disabled: boolean;
    readonly onChange: (next: SoundChoice) => void;
}

const isChoice = (id: string): id is SoundChoice => SOUND_CHOICES.some((choice) => choice.id === id);

export default function SoundPicker({ value, disabled, onChange }: SoundPickerProps): ReactElement {
    const selectId = useId();
    return (
        <div className={ROW_CLASS}>
            <div className="flex flex-col justify-center">
                <label htmlFor={selectId} className={TITLE_CLASS}>Sound</label>
                <span className={CAPTION_CLASS}>Played for the goal and for each finished pomodoro</span>
            </div>
            <div className="flex items-center gap-2">
                <select
                    id={selectId}
                    className={SELECT_CLASS}
                    value={value}
                    disabled={disabled}
                    onChange={(event) => {
                        const next = event.target.value;
                        if (isChoice(next)) {
                            onChange(next);
                            playSound(next);
                        }
                    }}
                >
                    {SOUND_CHOICES.map((choice) => (
                        <option key={choice.id} value={choice.id}>{choice.label}</option>
                    ))}
                </select>
                <button
                    type="button"
                    className={PLAY_CLASS}
                    disabled={disabled}
                    aria-label="Play this sound"
                    onClick={() => { playSound(value); }}
                >
                    <span className="material-symbols-outlined text-[20px]">play_arrow</span>
                </button>
            </div>
        </div>
    );
}

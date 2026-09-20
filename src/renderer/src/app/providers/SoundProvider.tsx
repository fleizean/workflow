/*
 * SPA-10: the notification sound, played from inside the bundle.
 *
 * Only a document can play audio, so main decides WHEN and says so over app:playSound; this is the one place that
 * listens. v1.2.1 played new Audio('../assets/notification.mp3') from a page (replaced by the sounds under assets/sounds/), so a hidden window played nothing.
 *
 * The import is what makes it local: Vite fingerprints the file into out/renderer/assets and hands back its URL, so
 * the src is a file:// address inside the app and media-src 'self' admits it. One element per sound, reused:
 * constructing an Audio per event leaks a decoder per notification. Both ids are a lookup, not a name built by
 * concatenation (C3).
 */

import { useEffect } from 'react';
import type { ReactElement, ReactNode } from 'react';
import chimeSound from '@assets/sounds/chime.ogg';
import classicSound from '@assets/sounds/classic.ogg';
import confirmSound from '@assets/sounds/confirm.ogg';
import glassSound from '@assets/sounds/glass.ogg';
import pepSound from '@assets/sounds/pep.ogg';
import questionSound from '@assets/sounds/question.ogg';
import riseSound from '@assets/sounds/rise.ogg';
import threeToneSound from '@assets/sounds/three-tone.ogg';
import twoToneSound from '@assets/sounds/two-tone.ogg';
import { subscribe } from '@renderer/lib/ipc';
import type { SoundChoice } from '@shared/types';

// Which file a choice plays. Which event asked no longer matters: the user picks one sound for both.
const SOUND_SRC: Record<SoundChoice, string> = {
    classic: classicSound,
    chime: chimeSound,
    glass: glassSound,
    confirm: confirmSound,
    question: questionSound,
    'two-tone': twoToneSound,
    'three-tone': threeToneSound,
    rise: riseSound,
    pep: pepSound
};

const elements = new Map<string, HTMLAudioElement>();

function elementFor(src: string): HTMLAudioElement {
    const existing = elements.get(src);
    if (existing !== undefined) {
        return existing;
    }
    const created = new Audio(src);
    created.preload = 'auto';
    elements.set(src, created);
    return created;
}

/** Best effort, like the notifier: a sound that will not play is not a reason to break the thing that raised it. */
export function playSound(choice: SoundChoice): void {
    const element = elementFor(SOUND_SRC[choice]);
    element.currentTime = 0;
    element.play().catch(() => undefined);
}

export function SoundProvider({ children }: { children: ReactNode }): ReactElement {
    useEffect(() => subscribe('app:playSound', (payload) => { playSound(payload.choice); }), []);
    return <>{children}</>;
}

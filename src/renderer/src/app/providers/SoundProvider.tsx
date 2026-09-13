/*
 * SPA-10: the notification sound, played from inside the bundle.
 *
 * Only a document can play audio, so main decides WHEN (goal reached, pomodoro completed) and says so over
 * app:playSound; this is the one place that listens. v1.2.1 played new Audio('../assets/notification.mp3') from a
 * page, which meant a hidden window played nothing and a relative path that changed with the page.
 *
 * The import is what makes it local: Vite fingerprints the file into out/renderer/assets and hands back its URL, so
 * the src is a file:// address inside the app and media-src 'self' admits it. A string path would not be rewritten
 * by the bundler and would resolve against whatever document happened to be loaded.
 *
 * One element per sound, reused: constructing an Audio per event leaks a decoder per notification. Both ids point
 * at the one file v1.2.1 shipped - a lookup, not a name built by concatenation (C3).
 */

import { useEffect } from 'react';
import type { ReactElement, ReactNode } from 'react';
import notificationSound from '@assets/notification.mp3';
import { subscribe } from '@renderer/lib/ipc';
import type { SoundId } from '@shared/types';

const SOUND_SRC: Record<SoundId, string> = {
    goalReached: notificationSound,
    pomodoroCompleted: notificationSound
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
export function playSound(sound: SoundId): void {
    const element = elementFor(SOUND_SRC[sound]);
    element.currentTime = 0;
    element.play().catch(() => undefined);
}

export function SoundProvider({ children }: { children: ReactNode }): ReactElement {
    useEffect(() => subscribe('app:playSound', (payload) => { playSound(payload.sound); }), []);
    return <>{children}</>;
}

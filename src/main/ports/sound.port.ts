// Playing audio needs a document, so only the renderer can do it. The decision is main's; this is how it asks.

import type { SoundId } from '@shared/types';

export interface SoundPort {
    /** Best effort: with no window on screen there is nothing to play on, and that is not a failure. */
    play(sound: SoundId): void;
}

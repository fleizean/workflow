// SoundPort over the renderer bus: playing audio needs a document, so main only ever asks.

import type { RendererBusPort, SoundPort } from '../ports';

export function createRendererSound(bus: RendererBusPort): SoundPort {
    return {
        play: (sound, choice) => { bus.emit('app:playSound', { sound, choice }); }
    };
}

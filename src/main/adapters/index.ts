// The implementations of src/main/ports, and the only modules outside the bootstrap, window, lifecycle, tray and
// ipc/ that may touch an Electron API (ARCH-01). src/main/container.ts is the one caller.

export { createSystemClock } from './system-clock.adapter';
export { createElectronNotifier } from './electron-notifier.adapter';
export { createElectronRendererBus } from './electron-renderer-bus.adapter';
export { createNodeScheduler } from './node-scheduler.adapter';
export { createRendererSound } from './renderer-sound.adapter';

import type { AppPorts } from '../ports';
import { createElectronNotifier } from './electron-notifier.adapter';
import { createElectronRendererBus } from './electron-renderer-bus.adapter';
import { createNodeScheduler } from './node-scheduler.adapter';
import { createRendererSound } from './renderer-sound.adapter';
import { createSystemClock } from './system-clock.adapter';

/** Every port a service may reach the outside world through, in one construction. `log` carries best-effort failures. */
export function createElectronPorts(log: (line: string) => void): AppPorts {
    const bus = createElectronRendererBus(log);
    return {
        clock: createSystemClock(),
        notifier: createElectronNotifier(log),
        sound: createRendererSound(bus),
        bus,
        scheduler: createNodeScheduler()
    };
}

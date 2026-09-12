// SchedulerPort over Node's timers. Main-process timers are not subject to Chromium's hidden-window throttling,
// which is the whole reason the clock lives here and not in the renderer (X1).

import type { RepeatingTimer, SchedulerPort } from '../ports';

export function createNodeScheduler(): SchedulerPort {
    return {
        every(intervalMs, run): RepeatingTimer {
            const handle = setInterval(run, intervalMs);
            // The tick is not a reason to keep the process alive; quitting is decided by windows and the tray.
            handle.unref();
            let cancelled = false;
            return {
                cancel: () => {
                    if (cancelled) return;
                    cancelled = true;
                    clearInterval(handle);
                }
            };
        }
    };
}

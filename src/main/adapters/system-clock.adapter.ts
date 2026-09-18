// ClockPort over the process clocks. Nothing here is Electron's: the main process is plain Node for this.

import type { ClockPort } from '../ports';

/**
 * `monotonicNow` is performance.now(), which never goes back - the property CORE-04 depends on, since a backwards
 * delta would either destroy tracked time or, once clamped to zero, hide that the clock moved at all.
 */
export function createSystemClock(): ClockPort {
    return {
        now: () => Date.now(),
        monotonicNow: () => performance.now()
    };
}

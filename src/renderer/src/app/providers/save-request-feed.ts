/*
 * PANEL-02: main telling this window that the save form is what it was raised for.
 *
 * A plain function taking its sink, for the reason timer-feed.ts is one: that is what lets a test mount this very
 * subscription in node and read the store back, rather than a copy of the wiring.
 */

import { subscribe } from '@renderer/lib/ipc';
import type { IpcEventPayload } from '@shared/types';

export const subscribeSaveRequests = (
    write: (payload: IpcEventPayload<'shell:saveRequested'>) => void
): (() => void) => subscribe('shell:saveRequested', write);

/*
 * PANEL-02: the tray panel's Stop, received.
 *
 * The panel cannot stop the timer - timer:stopAndSave needs a company and a note, a note-required company refuses
 * an empty one, and Phase 5 made that one atomic call precisely because two calls duplicate or lose the session
 * (WR-06). So the panel raises this window and says what for; AppShell puts Home on screen and TimerPage opens the
 * form over the clock that is still running.
 *
 * A provider rather than something a screen mounts: the request arrives for whatever route the window was left on,
 * and a subscription owned by Home would not be there to hear it.
 */

import { useEffect } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { writeSaveRequest } from '@renderer/store/ui.store';
import { subscribeSaveRequests } from './save-request-feed';

export function SaveRequestProvider({ children }: { children: ReactNode }): ReactElement {
    useEffect(() => subscribeSaveRequests(({ requestedAt }) => { writeSaveRequest(requestedAt); }), []);

    return <>{children}</>;
}

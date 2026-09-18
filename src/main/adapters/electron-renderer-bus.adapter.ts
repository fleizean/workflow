// RendererBusPort over the main windows' webContents. Services hold the port, never a BrowserWindow (ARCH-01).

import { describeError } from '../errors';
import type { RendererBusPort } from '../ports';
import { mainWindows } from '../window';

/** All the adapter needs of a window; BrowserWindow satisfies it, so nothing wider is reachable through it. */
export interface RendererTarget {
    readonly webContents: {
        isDestroyed(): boolean;
        send(channel: string, payload: unknown): void;
    };
}

/**
 * Delivers to every live main window and drops the event when there is none - the port's contract, and what the
 * tray-hidden app needs: an event nobody can receive is not an error the service that raised it has to handle.
 */
export function createElectronRendererBus(
    log: (line: string) => void,
    targets: () => readonly RendererTarget[] = mainWindows
): RendererBusPort {
    return {
        emit(channel, payload) {
            for (const target of targets()) {
                const { webContents } = target;
                if (webContents.isDestroyed()) {
                    continue;
                }
                try {
                    webContents.send(channel, payload);
                } catch (error) {
                    log('renderer bus: ' + channel + ' not delivered - ' + describeError(error));
                }
            }
        }
    };
}

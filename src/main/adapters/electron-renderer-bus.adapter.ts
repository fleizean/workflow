// RendererBusPort over the main windows' webContents. Services hold the port, never a BrowserWindow (ARCH-01).

import { describeError } from '../errors';
import { panelWindows } from '../panel';
import type { RendererBusPort } from '../ports';
import { mainWindows } from '../window';

/** All the adapter needs of a window; BrowserWindow satisfies it, so nothing wider is reachable through it. */
export interface RendererTarget {
    readonly webContents: {
        isDestroyed(): boolean;
        /*
         * Measured in real Electron 44.2.0: after the render process dies this is TRUE while isDestroyed() stays
         * FALSE and send() does NOT throw. isDestroyed() alone therefore cannot see a dead renderer, and the next
         * reader will not believe that without being told. It is the whole of the macOS lid-close freeze: timer:tick
         * and data:changed both ride this one send, so one dead renderer closes the display AND every recovery path,
         * in total silence.
         */
        isCrashed(): boolean;
        send(channel: string, payload: unknown): void;
    };
}

/**
 * Delivers to every live main window and drops the event when there is none - the port's contract, and what the
 * tray-hidden app needs: an event nobody can receive is not an error the service that raised it has to handle.
 */
/*
 * PANEL-04: every window that renders app state, which is the main window and - while it is open - the tray panel.
 * The panel draws the same tick, so without it here the panel's figures would be whatever the opening snapshot
 * said and would never move again.
 */
const rendererWindows = (): readonly RendererTarget[] => [...mainWindows(), ...panelWindows()];

export function createElectronRendererBus(
    log: (line: string) => void,
    targets: () => readonly RendererTarget[] = rendererWindows
): RendererBusPort {
    // Said once per target, not once per tick: the stream is 1 Hz and a dead renderer stays dead until it reloads.
    const reported = new WeakSet<object>();

    return {
        emit(channel, payload) {
            for (const target of targets()) {
                const { webContents } = target;
                if (webContents.isDestroyed()) {
                    continue;
                }
                if (webContents.isCrashed()) {
                    if (!reported.has(webContents)) {
                        reported.add(webContents);
                        log('renderer bus: ' + channel + ' is being dropped - the render process is gone while its ' +
                            'window is not destroyed, so send() would report nothing');
                    }
                    continue;
                }
                reported.delete(webContents);
                try {
                    webContents.send(channel, payload);
                } catch (error) {
                    log('renderer bus: ' + channel + ' not delivered - ' + describeError(error));
                }
            }
        }
    };
}

// Main-to-renderer push, over the channels ipcEvents declares. A service holds this, never a BrowserWindow.

import type { IpcEventChannel, IpcEventPayload } from '@shared/types';

export interface RendererBusPort {
    /** Delivers to every live main window. With none on screen the event is dropped, not queued. */
    emit<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void;
}

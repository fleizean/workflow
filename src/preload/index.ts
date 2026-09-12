// The sandboxed CommonJS preload: two frozen bridges and nothing else. It validates nothing - main does that, and a
// second copy of the schemas here would be a second answer to the same question, in the renderer process.

import { contextBridge, ipcRenderer } from 'electron';
import { API_BRIDGE_KEY, SHELL_BRIDGE_KEY } from '@shared/constants/bridge';
import { IPC_CHANNELS } from '@shared/ipc/channels';
import { createIpcBridge } from './bridge';

export const BRIDGE_VERSION = 'phase-5-typed-bridge';

// What the packaged smoke reads back to prove the preload loaded at all (IN-01).
const shellBridge = Object.freeze({
    version: BRIDGE_VERSION,
    channelCount: IPC_CHANNELS.length
});

contextBridge.exposeInMainWorld(SHELL_BRIDGE_KEY, shellBridge);
contextBridge.exposeInMainWorld(API_BRIDGE_KEY, createIpcBridge(ipcRenderer));

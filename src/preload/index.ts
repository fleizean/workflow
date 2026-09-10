// Placeholder preload: proves a sandboxed CommonJS preload and a contextBridge crossing both load.
// It exposes no application API; the typed bridge is IPC-01 (Phase 6).

import { contextBridge } from 'electron';
import { SHELL_BRIDGE_KEY } from '@shared/constants/bridge';

const shellBridge = Object.freeze({
    version: 'phase-2-placeholder'
});

contextBridge.exposeInMainWorld(SHELL_BRIDGE_KEY, shellBridge);

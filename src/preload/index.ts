/*
 * src/preload/index.ts
 *
 * A placeholder. It exposes NO application API: the typed bridge that replaces preload.js's 25
 * functions is Phase 6's contract (IPC-01), and writing any of it here would fix its shape before
 * the IPC design exists.
 *
 * It exists so the launch actually exercises what Phase 6 will rely on: a preload that loads
 * under sandbox: true (which requires it to be CommonJS - hence no "type": "module" in
 * package.json), and a contextBridge crossing under contextIsolation: true. The packaged smoke
 * launch reads the version below back out of the page to prove both held.
 */

import { contextBridge } from 'electron';

// src/main/index.ts reads this key back during the --smoke launch; keep the two in step.
const SHELL_BRIDGE_KEY = 'workflowShell';

const shellBridge = Object.freeze({
    version: 'phase-2-placeholder'
});

contextBridge.exposeInMainWorld(SHELL_BRIDGE_KEY, shellBridge);

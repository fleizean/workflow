// What the renderer may assume about window. Types only: importing this loads nothing (ARCH-03 keeps the calls
// themselves inside features/*/api and app/providers).

import type { IpcBridge } from '@shared/types';

declare global {
    interface Window {
        readonly api: IpcBridge;
        readonly workflowShell: { readonly version: string; readonly channelCount: number };
    }
}

export {};

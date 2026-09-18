// The key the preload exposes its bridge under; the smoke launch reads it back from the page (IN-01).
export const SHELL_BRIDGE_KEY = 'workflowShell';

// The typed IPC bridge (IPC-01). Renderer code calls window.api; only features/*/api and app/providers may.
export const API_BRIDGE_KEY = 'api';

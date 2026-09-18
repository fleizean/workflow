// The closed list of IPC failure codes (D-17). Zod-free, so the renderer can import it.
export const IPC_ERROR_CODES = ['INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'INTERNAL'] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

// The one sentence an unexplained failure carries. Shared because the preload says it too, for a call that
// never reached main: an argument structured clone cannot carry throws before the invoke leaves (WR-05).
export const INTERNAL_ERROR_MESSAGE = 'Something went wrong and the action was not completed.';

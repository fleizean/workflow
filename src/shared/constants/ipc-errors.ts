// The closed list of IPC failure codes (D-17). Zod-free, so the renderer can import it.
export const IPC_ERROR_CODES = ['INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'INTERNAL'] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

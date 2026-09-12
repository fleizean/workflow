// The ipc layer's public surface. It imports services and the shared contract, and nothing below either (ARCH-01).

export { createDispatch } from './dispatch';
export type { Dispatch, DispatchInput } from './dispatch';
export { INTERNAL_MESSAGE, invalidInputError, toIpcError } from './errors';
export { createHandlers } from './handlers';
export type { HandlerContext, WindowControls } from './handlers';
export { registerIpcHandlers, removeIpcHandlers } from './register';
export type { RegisterIpcInput } from './register';

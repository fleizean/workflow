// The channel names alone, stated without zod so the preload can generate its bridge from them without pulling the
// schemas into the renderer process. contract.ts proves at compile time that this list and the contract agree.

export const IPC_CHANNELS = [
    'sessions:list',
    'sessions:listByDateRange',
    'sessions:listByDateAndCompany',
    'sessions:create',
    'sessions:update',
    'sessions:delete',
    'sessions:deleteAll',
    'companies:list',
    'companies:get',
    'companies:create',
    'companies:update',
    'companies:delete',
    'settings:get',
    'settings:update',
    'timer:getSnapshot',
    'timer:start',
    'timer:pause',
    'timer:reset',
    'timer:setMode',
    'pomodoro:getSnapshot',
    'pomodoro:start',
    'pomodoro:pause',
    'pomodoro:abort',
    'pomodoro:skipBreak',
    'pomodoro:counts',
    'stats:streak',
    'stats:weekTotals',
    'stats:dayProgress',
    'window:minimize',
    'window:close'
] as const;

export const IPC_EVENT_CHANNELS = ['app:playSound', 'timer:tick', 'pomodoro:tick'] as const;

export type DeclaredIpcChannel = (typeof IPC_CHANNELS)[number];
export type DeclaredIpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number];

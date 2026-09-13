// IPC-02, criterion 7: one handler per channel, each of them validate (done for them in dispatch.ts) then one
// service call then the answer. No branch lives here - a decision a handler would have to make belongs to the
// service that owns it, and tests/ipc-handlers.test.ts fails on a handler body that grows one.

import type { IpcHandlers } from '@shared/types';
import type { CompaniesService } from '../services/companies.service';
import type { PomodoroService } from '../services/pomodoro.service';
import type { SessionsService } from '../services/sessions.service';
import type { SettingsService } from '../services/settings.service';
import type { StatsService } from '../services/stats.service';
import type { TimerCommands } from '../container';

/** The window the titlebar drives. v1.2.1 hid on both, and the tray is where the window went (IPC-05). */
export interface WindowControls {
    minimize(): void;
    close(): void;
}

export interface HandlerContext {
    readonly sessions: SessionsService;
    readonly companies: CompaniesService;
    readonly settings: SettingsService;
    /** The composition root's timer: TimerService plus the one pairing the renderer cannot do atomically (WR-06). */
    readonly timer: TimerCommands;
    readonly pomodoro: PomodoroService;
    readonly stats: StatsService;
    readonly window: WindowControls;
}

export function createHandlers(context: HandlerContext): IpcHandlers {
    const { companies, pomodoro, sessions, settings, stats, timer, window } = context;

    return {
        'sessions:list': () => sessions.list(),
        'sessions:listByDateRange': (input) => sessions.listByDateRange(input.startDate, input.endDate),
        'sessions:listByDateAndCompany': (input) => sessions.listByDateAndCompany(input.date, input.companyId),
        'sessions:create': (input) => sessions.create(input),
        'sessions:update': (input) => sessions.update(input.id, input),
        'sessions:delete': (input) => { sessions.remove(input.id); },
        'sessions:deleteAll': () => ({ deletedSessionCount: sessions.removeAll() }),

        'companies:list': () => companies.list(),
        'companies:get': (input) => companies.get(input.id),
        'companies:create': (input) => companies.create(input),
        'companies:update': (input) => companies.update(input.id, input),
        'companies:delete': (input) => companies.remove(input.id),

        'settings:get': () => settings.get(),
        'settings:update': (input) => settings.update(input),

        'timer:getSnapshot': () => timer.snapshot(),
        'timer:start': () => timer.start(),
        'timer:pause': () => timer.pause(),
        'timer:reset': () => timer.reset(),
        'timer:setMode': (input) => timer.setMode(input.mode),
        'timer:stopAndSave': (input) => timer.stopAndSave(input),

        'pomodoro:getSnapshot': () => pomodoro.snapshot(),
        'pomodoro:start': () => pomodoro.start(),
        'pomodoro:pause': () => pomodoro.pause(),
        'pomodoro:abort': () => pomodoro.abort(),
        'pomodoro:skipBreak': () => pomodoro.skipBreak(),
        'pomodoro:counts': () => stats.pomodoroCounts(),

        'stats:streak': () => stats.streak(),
        'stats:weekTotals': () => stats.weeks(),
        'stats:dayProgress': (input) => stats.dayProgress(input.date),

        'window:minimize': () => { window.minimize(); },
        'window:close': () => { window.close(); }
    };
}

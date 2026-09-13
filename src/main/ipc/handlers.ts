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

/**
 * What the titlebar drives (IPC-05). The two buttons mean different things as of the owner's 2026-09-13 decision:
 * one puts the window away, the other ends the process. Where "away" is - the tray or the taskbar - is main's
 * decision, taken in window.ts.
 */
export interface ShellControls {
    hide(): void;
    /** True the first time and never again: whether this hide owes the user an explanation. */
    claimHideNotice(): { due: boolean };
    quit(): void;
}

export interface HandlerContext {
    readonly sessions: SessionsService;
    readonly companies: CompaniesService;
    readonly settings: SettingsService;
    /** The composition root's timer: TimerService plus the one pairing the renderer cannot do atomically (WR-06). */
    readonly timer: TimerCommands;
    readonly pomodoro: PomodoroService;
    readonly stats: StatsService;
    readonly shell: ShellControls;
}

export function createHandlers(context: HandlerContext): IpcHandlers {
    const { companies, pomodoro, sessions, settings, shell, stats, timer } = context;

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

        'window:hide': () => { shell.hide(); },
        'window:claimHideNotice': () => shell.claimHideNotice(),
        'app:quit': () => { shell.quit(); }
    };
}

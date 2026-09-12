// The one composition root (ARCH-01): adapters, then repositories over the connection database-startup.ts opened,
// then the services. It opens nothing itself - the door, the classification and the migration stay in
// database-startup.ts - and it names no Electron API, only the adapter factories that do.
// The database layer arrives as an argument, so loading this module still loads no database code (D-10).

import { instantFromEpochMs } from '@shared/utils/date';
import { createElectronPorts } from './adapters';
import { GOAL_NOTIFICATION, POMODORO_SESSION_NAME, notificationForCompletion } from './notifications';
import type { DatabaseLayer, StartedDatabase } from './database-startup';
import type { AppPorts, ClockPort } from './ports';
import { createCompaniesService } from './services/companies.service';
import type { CompaniesService } from './services/companies.service';
import { createGoalService } from './services/goal.service';
import type { GoalNotificationStore, GoalService } from './services/goal.service';
import { createPomodoroService } from './services/pomodoro.service';
import type { PomodoroCompletion, PomodoroService } from './services/pomodoro.service';
import { createSessionsService } from './services/sessions.service';
import type { SessionsService } from './services/sessions.service';
import { createSettingsService } from './services/settings.service';
import type { SettingsService } from './services/settings.service';
import { createStatsService } from './services/stats.service';
import type { StatsService } from './services/stats.service';
import { createTimerService } from './services/timer.service';
import type { TimerService, TimerStateStore } from './services/timer.service';
import type { TimerSnapshot } from '@shared/types';
import type {
    CompaniesRepository, PomodoroRepository, RepositoryOptions, SessionsRepository, SettingsRepository, SkippedRowReport
} from '../lib/db';

export interface Repositories {
    readonly sessions: SessionsRepository;
    readonly companies: CompaniesRepository;
    readonly settings: SettingsRepository;
    readonly pomodoro: PomodoroRepository;
}

export interface Services {
    readonly sessions: SessionsService;
    readonly companies: CompaniesService;
    readonly settings: SettingsService;
    readonly stats: StatsService;
    readonly timer: TimerService;
    readonly pomodoro: PomodoroService;
    readonly goal: GoalService;
}

/*
 * CORE-13: the goal decision is asked on the timer's tick rather than on a clock of its own, but not on every one of
 * them - answering it costs a day-totals read, and a daily goal is not something a few seconds late matters to. Once
 * it has fired the answer is free, so this bounds only the cost of not having reached the target yet.
 */
export const GOAL_EVALUATION_INTERVAL_SECONDS = 10;

export interface AppContainer {
    readonly ports: AppPorts;
    readonly repositories: Repositories;
    readonly services: Services;
    /** One BEGIN IMMEDIATE around `work`, so a service can compose two repositories without holding the handle. */
    transaction<T>(work: () => T): T;
    /** Flushes and stops what the services hold open. Called before the connection closes, never after. */
    dispose(): void;
}

export interface ContainerInput {
    readonly layer: DatabaseLayer;
    /** The open connection startDatabase returned; the container never opens or closes one. */
    readonly connection: StartedDatabase['db'];
    readonly log: (line: string) => void;
    /** The Electron and Node adapters unless a caller supplies its own; nothing in production does. */
    readonly ports?: AppPorts;
}

/*
 * A database a third-party tool edited can hold many unmappable rows, and every list() would report each one again.
 * So a given table/column/row/reason is reported once per run, and the whole reporter falls silent after this many
 * distinct reports: a log that fills the disk is a worse outcome than an anomaly reported once and then counted.
 */
export const SKIPPED_ROW_REPORT_LIMIT = 50;

/** Table, column, row id and reason only - never a stored value, because a session name or a note is user data. */
export function skippedRowLine(skipped: SkippedRowReport): string {
    const where = skipped.rowId === null ? 'no row id' : 'row ' + String(skipped.rowId);
    return 'database: ' + skipped.table + '.' + skipped.column + ', ' + where +
        ' was left out of a result - ' + skipped.reason;
}

export function createSkippedRowReporter(log: (line: string) => void): (skipped: SkippedRowReport) => void {
    const seen = new Set<string>();
    let suppressed = false;
    return (skipped) => {
        const key = skipped.table + '.' + skipped.column + '#' + String(skipped.rowId) + '|' + skipped.reason;
        if (seen.has(key)) {
            return;
        }
        if (seen.size >= SKIPPED_ROW_REPORT_LIMIT) {
            if (!suppressed) {
                suppressed = true;
                log('database: further unreadable rows will not be reported this run (' +
                    String(SKIPPED_ROW_REPORT_LIMIT) + ' already were)');
            }
            return;
        }
        seen.add(key);
        log(skippedRowLine(skipped));
    };
}

function createGoalNotificationStore(
    layer: DatabaseLayer,
    connection: StartedDatabase['db'],
    clock: ClockPort
): GoalNotificationStore {
    return {
        read: () => layer.readGoalNotifiedDate(connection),
        write: (date) => { layer.writeGoalNotifiedDate(connection, date, instantFromEpochMs(clock.now())); }
    };
}

// The timer reaches the database through one scalar in and one scalar out, and only through app-state.ts (CORE-07).
function createTimerStateStore(
    layer: DatabaseLayer,
    connection: StartedDatabase['db'],
    clock: ClockPort
): TimerStateStore {
    return {
        read: () => {
            const restored = layer.readTimerState(connection);
            return { accumulatedSeconds: restored.accumulatedSeconds, mode: restored.mode };
        },
        // The wall clock names the moment of the write and never measures one; the seconds come from the service.
        write: (state) => { layer.writeTimerState(connection, state, instantFromEpochMs(clock.now())); }
    };
}

export function createContainer(input: ContainerInput): AppContainer {
    const { layer, log } = input;
    const ports = input.ports ?? createElectronPorts(log);
    const handle = layer.createDbHandle(input.connection);
    // Slice B's reporter, wired here for the first time: until now an unmappable row was dropped in silence.
    const options: RepositoryOptions = { onSkippedRow: createSkippedRowReporter(log) };

    const repositories: Repositories = {
        sessions: layer.createSessionsRepository(handle, options),
        companies: layer.createCompaniesRepository(handle, options),
        settings: layer.createSettingsRepository(handle),
        pomodoro: layer.createPomodoroRepository(handle, options)
    };
    const transaction = <T>(work: () => T): T => layer.transact(handle, work);

    const settings = createSettingsService(repositories.settings);
    const stats = createStatsService({
        clock: ports.clock,
        sessions: repositories.sessions,
        pomodoro: repositories.pomodoro,
        settings
    });
    const goal = createGoalService({
        clock: ports.clock,
        store: createGoalNotificationStore(layer, input.connection, ports.clock),
        log
    });

    // The whole day, including the seconds the running timer is still holding: a goal is met by time worked, not by
    // time already written to a row (CORE-08, B7).
    function evaluateGoal(snapshot: TimerSnapshot): void {
        if (snapshot.status !== 'running' || snapshot.elapsedSeconds % GOAL_EVALUATION_INTERVAL_SECONDS !== 0) {
            return;
        }
        const current = settings.get();
        const decision = goal.evaluate({
            totalSecondsToday: stats.today().totalSeconds + snapshot.elapsedSeconds,
            settings: {
                dailyTargetSeconds: current.dailyTargetSeconds,
                goalNotification: current.goalNotification
            }
        });
        if (decision.notify) {
            // Both, and from main: v1.2.1 raised the notification from a renderer that is not running while the
            // window is hidden in the tray, which is the half of B1 the user never saw at all.
            ports.notifier.notify(GOAL_NOTIFICATION);
            ports.sound.play('goalReached');
        }
    }

    const timer = createTimerService({
        clock: ports.clock,
        scheduler: ports.scheduler,
        bus: ports.bus,
        store: createTimerStateStore(layer, input.connection, ports.clock),
        onSnapshot: evaluateGoal,
        log
    });

    /*
     * POMO-01: the work session and the pomodoro row are written together, before anything asks the user which
     * company it was for. Killing the app at that prompt therefore loses no time - the session is already on disk,
     * unattributed, and Phase 8's prompt attributes it with an ordinary session update.
     */
    function recordCompletion(completion: PomodoroCompletion): void {
        if (completion.interval === 'work') {
            transaction(() => {
                repositories.sessions.create({
                    name: POMODORO_SESSION_NAME,
                    durationSeconds: completion.elapsedSeconds,
                    date: completion.date,
                    companyId: null,
                    note: null
                });
                repositories.pomodoro.recordCompletion(completion.date, null);
            });
        }
        ports.notifier.notify(notificationForCompletion(completion.interval));
        ports.sound.play('pomodoroCompleted');
    }

    const pomodoro = createPomodoroService({
        clock: ports.clock,
        scheduler: ports.scheduler,
        ledger: repositories.pomodoro,
        durations: () => {
            const current = settings.get();
            return {
                workSeconds: current.pomodoroWorkSeconds,
                shortBreakSeconds: current.pomodoroShortBreakSeconds,
                longBreakSeconds: current.pomodoroLongBreakSeconds,
                sessionsUntilLongBreak: current.pomodoroSessionsUntilLongBreak
            };
        },
        onCompleted: recordCompletion,
        onChanged: (snapshot) => { ports.bus.emit('pomodoro:tick', snapshot); },
        log
    });

    return {
        ports,
        repositories,
        services: {
            sessions: createSessionsService(repositories.sessions, repositories.companies),
            companies: createCompaniesService({
                companies: repositories.companies,
                sessions: repositories.sessions,
                transaction
            }),
            settings,
            stats,
            timer,
            pomodoro,
            goal
        },
        transaction,
        dispose: () => {
            pomodoro.dispose();
            timer.dispose();
        }
    };
}

let active: AppContainer | undefined;

/** Set once startup has a migrated database; the ipc/ layer resolves its services through activeContainer(). */
export function setActiveContainer(container: AppContainer): void {
    active = container;
}

/**
 * Flushes the services before the connection closes; a timer that persisted afterwards would lose the seconds it
 * was holding to a driver error far from the cause. Returns why it could not, because quitting must finish anyway.
 */
export function disposeActiveContainer(): string | null {
    if (active === undefined) {
        return null;
    }
    try {
        active.dispose();
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : 'unknown';
    }
}

/** Cleared when the database closes, so a repository over a closed connection is never handed out (D-32). */
export function clearActiveContainer(): void {
    active = undefined;
}

export function activeContainer(): AppContainer {
    if (active === undefined) {
        throw new Error('src/main/container.ts: no container is active; the database is not open');
    }
    return active;
}

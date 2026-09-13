// The one composition root (ARCH-01): adapters, then repositories over the connection database-startup.ts opened,
// then the services. It opens nothing itself - the door, the classification and the migration stay in
// database-startup.ts - and it names no Electron API, only the adapter factories that do.
// The database layer arrives as an argument, so loading this module still loads no database code (D-10).

import { instantFromEpochMs } from '@shared/utils/date';
import { createElectronPorts } from './adapters';
import { describeError } from './errors';
import {
    GOAL_NOTIFICATION, POMODORO_NOT_RECORDED_NOTIFICATION, POMODORO_SESSION_NAME, notificationForCompletion
} from './notifications';
import type { DatabaseLayer, StartedDatabase } from './database-startup';
import type { AppPorts, ClockPort } from './ports';
import { createCompaniesService } from './services/companies.service';
import type { CompaniesService } from './services/companies.service';
import { createGoalService } from './services/goal.service';
import type { GoalNotificationStore, GoalService } from './services/goal.service';
import { createPomodoroService } from './services/pomodoro.service';
import type { PomodoroCompletion, PomodoroService, PomodoroStateStore } from './services/pomodoro.service';
import { createSessionsService } from './services/sessions.service';
import type { SessionsService } from './services/sessions.service';
import { createSettingsService } from './services/settings.service';
import type { SettingsService } from './services/settings.service';
import { createStatsService } from './services/stats.service';
import type { StatsService } from './services/stats.service';
import { createTimerService } from './services/timer.service';
import type { CountedDay, TimerService, TimerStateStore } from './services/timer.service';
import type { PomodoroSnapshot, TimerSnapshot } from '@shared/types';
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

// WR-03: the cycle reaches the database the same way the timer does - one record in, one record out, app-state.ts
// only. The wall clock names the moment of the write and never measures one.
function createPomodoroStateStore(
    layer: DatabaseLayer,
    connection: StartedDatabase['db'],
    clock: ClockPort
): PomodoroStateStore {
    return {
        read: () => layer.readPomodoroState(connection),
        write: (state) => { layer.writePomodoroState(connection, state, instantFromEpochMs(clock.now())); }
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

    // The second the goal was last measured at, so the sampler below compares rather than takes a residue.
    let lastGoalCheckAt = -GOAL_EVALUATION_INTERVAL_SECONDS;

    /** The tick's way in: how often the question is worth its cost, and whose seconds count when it is asked. */
    function evaluateGoal(snapshot: TimerSnapshot, counted: CountedDay): void {
        // A reset rewinds elapsedSeconds, so the mark rewinds with it - otherwise the rest of the day would be spent
        // waiting for a second the restarted clock will never reach.
        if (snapshot.elapsedSeconds < lastGoalCheckAt) {
            lastGoalCheckAt = -GOAL_EVALUATION_INTERVAL_SECONDS;
        }
        if (snapshot.status !== 'running') {
            return;
        }
        /*
         * Measured against the last second evaluated, never against a residue. MAX_CREDIT_MS lets one tick credit two
         * seconds on purpose, so elapsedSeconds does not land on every multiple of ten - and a sustained late cadence
         * from an odd second lands on none of them, which silenced the goal for the rest of the day (CR-02).
         */
        if (snapshot.elapsedSeconds - lastGoalCheckAt < GOAL_EVALUATION_INTERVAL_SECONDS) {
            return;
        }
        lastGoalCheckAt = snapshot.elapsedSeconds;
        /*
         * WR-10: in pomodoro mode the cycle writes each completed interval as its own session row, which the day's
         * total already counts. Adding the main clock's seconds on top would count the same wall clock twice and
         * announce at roughly half the target. Under-counting delays a notification; over-counting invents a day
         * that was not worked, and this app exists not to invent time.
         */
        announceGoalIfReached(snapshot.mode === 'pomodoro' ? null : counted);
    }

    /*
     * The day's own total: the seconds already written to a row plus the part of the running accumulation counted on
     * that same local day (CORE-08, B7). Scoping the second term is CR-01 - stats.today() is day-scoped and the
     * timer's accumulation is not, so adding them whole credited last night's unsaved hours to this morning. A
     * restored accumulation is counted on no day and adds nothing until the timer counts fresh seconds; saving it as
     * a session is what says which day it belongs to, which is the question G3/G4 puts to the user.
     *
     * Reachable from every path that can carry the day over the line, not from the tick alone: a pomodoro-only day,
     * a day typed in on History and a timer paused inside the sampling window each used to pass the target in
     * silence. goal.evaluate records the day before it answers yes, so asking three times announces once.
     *
     * A caller that measures the day by what is on disk passes null. The tick is the only one that adds running
     * seconds, so a save that does not also reset cannot have the same seconds counted as a row and as a total.
     */
    function announceGoalIfReached(counted: CountedDay | null): void {
        try {
            const today = stats.today();
            const current = settings.get();
            const running = counted !== null && counted.day === today.date ? counted.seconds : 0;
            const decision = goal.evaluate({
                totalSecondsToday: today.totalSeconds + running,
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
        } catch (error) {
            // A day that cannot be measured must never cost the caller its write, or the clock its tick.
            log('goal: the day could not be measured - ' + describeError(error));
        }
    }

    /** The write first and the announcement after it, so the answer is measured against what is now on disk. */
    function announcingGoal<T>(write: () => T): T {
        const written = write();
        announceGoalIfReached(null);
        return written;
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
            try {
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
            } catch (error) {
                // CR-01: the cycle is about to hold the interval rather than discard it, and the user has to be
                // told - from main, because the window may be hidden in the tray and stdout is nobody's screen.
                ports.notifier.notify(POMODORO_NOT_RECORDED_NOTIFICATION);
                throw error;
            }
        }
        // IN-01: outside the write's failure envelope and inside one of their own. These run after the transaction
        // committed, so an OS that refused a notification must not be reported as an interval that could not be
        // recorded - nor, after CR-01, leave the cycle holding an interval that is safely on disk.
        try {
            ports.notifier.notify(notificationForCompletion(completion.interval));
            ports.sound.play('pomodoroCompleted');
        } catch (error) {
            log('pomodoro: the completed interval was recorded but could not be announced - ' + describeError(error));
        }
        // The row the transaction above wrote may be the one that carried the day: a pomodoro-only day never starts
        // the main timer, so without this nothing would ever ask.
        announceGoalIfReached(null);
    }

    const pomodoro = createPomodoroService({
        clock: ports.clock,
        scheduler: ports.scheduler,
        ledger: repositories.pomodoro,
        store: createPomodoroStateStore(layer, input.connection, ports.clock),
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

    const sessions = createSessionsService(repositories.sessions, repositories.companies);

    /*
     * WR-02: at most one accumulator counts at a time. The two services each own a clock and a repeat, and neither
     * can see the other - by design, since a service that knew about its sibling would be a composition. So the
     * invariant belongs here, and it is enforced rather than documented: starting one pauses the other.
     *
     * Paused, not reset. Whatever the other one was holding is time the user really worked, and it stays counted
     * and savable; only the counting stops. Without this a 25-minute interval is written as a session row AND left
     * sitting in the main accumulator for the user to save again - fifty minutes recorded for twenty-five worked,
     * which is the invented-time half of the Core Value this phase exists to make unreachable.
     */
    const exclusive = {
        timer: (): TimerSnapshot => { pomodoro.pause(); return timer.start(); },
        pomodoro: (): PomodoroSnapshot => { timer.pause(); return pomodoro.start(); }
    };

    return {
        ports,
        repositories,
        services: {
            // A session written or edited can carry the day with no timer running at all - History's own screen does
            // exactly that. The rule belongs to the composition root: the service below owns sessions, not goals.
            sessions: {
                ...sessions,
                create: (input) => announcingGoal(() => sessions.create(input)),
                update: (id, input) => announcingGoal(() => sessions.update(id, input))
            },
            companies: createCompaniesService({
                companies: repositories.companies,
                sessions: repositories.sessions,
                transaction
            }),
            settings,
            stats,
            timer: { ...timer, start: exclusive.timer },
            pomodoro: { ...pomodoro, start: exclusive.pomodoro },
            goal
        },
        transaction,
        // The timer first, and whatever it does the pomodoro is stopped anyway: this is the last flush of counted
        // seconds before the connection closes, and it must not sit behind an unrelated teardown that can throw.
        dispose: () => {
            try {
                timer.dispose();
            } finally {
                pomodoro.dispose();
            }
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

/*
 * The pending adjustment: the correction Adjust makes to what the next save will be WRITTEN with.
 *
 * In the shipped 2.1.0 it was useState inside TimerPage, which is a ROUTE component. Add thirty minutes, look at
 * Work History, come back to Home: gone, with nothing said, and the next Save wrote the unadjusted duration. The
 * tray panel could not see it either, and the renderer can now be reloaded (3d9ee78), which discards anything held
 * in renderer memory alone.
 *
 * So it lives in main, as a field of its own beside the clock. Phase 8 refused a `timer:adjust` channel on the
 * grounds that a channel which adds seconds to the authoritative counter is a channel that invents work; that
 * reasoning stands, and the first suite here is what holds it to it - accumulatedMs does not move, and nothing of
 * the correction reaches the disk.
 *
 * Everything below is the real thing except Electron's transport: the real createTimerService over a controllable
 * monotonic clock and wall clock, the real createDispatch over the real contract, the real preload bridge shape,
 * the real lib/ipc facade, the real subscribeTimerTicks feed, the real Zustand store, and the real mutation
 * options useTimerCommands hands to useMutation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { createDispatch } from '@main/ipc/dispatch';
import { createTimerService } from '@main/services/timer.service';
import type { PersistedTimerState, TimerService } from '@main/services/timer.service';
import type { ClockPort, RendererBusPort, SchedulerPort } from '@main/ports';
import { subscribeTimerTicks } from '@renderer/app/providers/timer-feed';
import { timerSnapshotQuery } from '@renderer/features/timer/api/useTimerSnapshot';
import { adjustPendingSaveMutation } from '@renderer/features/timer/api/useTimerCommands';
import { readTimerSnapshot, setTimerSnapshot } from '@renderer/features/timer/state/timer.store';
import { describeWorkDial } from '@renderer/features/timer/timer-view';
import { countedTowardToday, describePanelTimer, describeProgress } from '@renderer/features/panel/panel-view';
import { API_BRIDGE_KEY } from '@shared/constants/bridge';
import { MAX_SESSION_DURATION_SECONDS } from '@shared/constants/sessions';
import { adjustmentLabel } from '@shared/utils/session-duration';
import { formatElapsed } from '@renderer/lib/duration';
import { ipcWrites } from '@shared/ipc/contract';
import type { IpcChannel, IpcHandlers, IpcResult, TimerSnapshot } from '@shared/types';
import { findAll, read, scriptKindFor } from './helpers/ts-imports';

// CORE-03: the service under here must load with electron refusing to load, and so must this suite.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

const TICK_MS = 1000;
const HALF_HOUR = 1800;
const EIGHT_HOURS = 8 * 3600;
const PAGE = 'src/renderer/src/features/timer/TimerPage.tsx';

/** Ten seconds before local midnight, so no zone this suite runs in disagrees about which day a tick lands on. */
const BEFORE_MIDNIGHT_MS = new Date(2026, 9, 12, 23, 59, 50).getTime();

interface Loop {
    readonly main: TimerService;
    readonly writes: PersistedTimerState[];
    readonly logs: string[];
    /** What the last store.write() left behind - the only thing a relaunch can restore. */
    persisted(): PersistedTimerState;
    /** Fires the scheduled tick `count` times, each a second of monotonic AND wall time later. */
    drive(count: number): void;
    /** Moves the wall clock alone, which is the only clock that names a local day. */
    jumpWallClock(ms: number): void;
    /** What the renderer is showing: whatever the store was last told, by a tick or by a call's answer. */
    screen(): TimerSnapshot | null;
    /** The Adjust dialog's tap, routed exactly as TimerPage routes it. */
    adjust(seconds: number): Promise<void>;
    /**
     * A route change, as faithfully as a suite with no jsdom can model one: everything the Home route component
     * held is dropped, the app-level providers stay mounted, and Home mounts again and re-reads main through the
     * real timerSnapshotQuery. Against 2.1.0 there was nothing here to re-read.
     */
    remountHome(): Promise<TimerSnapshot>;
}

let disposers: (() => void)[] = [];

afterEach(() => {
    for (const dispose of disposers) dispose();
    disposers = [];
    delete (globalThis as unknown as Record<string, unknown>)[API_BRIDGE_KEY];
});

function loop(initial: PersistedTimerState = { accumulatedSeconds: 0, mode: 'work' }): Loop {
    let mono = 50_000;
    let wall = BEFORE_MIDNIGHT_MS;
    const clock: ClockPort = { now: () => wall, monotonicNow: () => mono };

    let scheduled: (() => void) | undefined;
    const scheduler: SchedulerPort = {
        every: (_intervalMs, run) => {
            scheduled = run;
            return { cancel: () => { scheduled = undefined; } };
        },
        after: () => { throw new Error('the timer service schedules no one-shot delay'); }
    };

    const logs: string[] = [];
    const listeners = new Map<string, ((payload: unknown) => void)[]>();
    const bus: RendererBusPort = {
        emit: (channel, payload) => {
            for (const listener of listeners.get(channel) ?? []) listener(payload);
        }
    };

    const writes: PersistedTimerState[] = [];
    let persisted: PersistedTimerState = initial;
    const main = createTimerService({
        clock,
        scheduler,
        bus,
        store: {
            read: () => persisted,
            write: (state) => { persisted = state; writes.push(state); }
        },
        log: (line) => logs.push(line)
    });

    const handlers = {
        'timer:getSnapshot': () => main.snapshot(),
        'timer:start': () => main.start(),
        'timer:pause': () => main.pause(),
        'timer:reset': () => main.reset(),
        'timer:setMode': (input: { mode: 'work' | 'pomodoro' }) => main.setMode(input.mode),
        'timer:adjustPendingSave': (input: { seconds: number }) => main.adjustPendingSave(input.seconds)
    };

    const dispatch = createDispatch({
        handlers: () => handlers as unknown as IpcHandlers,
        log: (line) => logs.push(line)
    });

    const bridge: Record<string, unknown> = {};
    for (const channel of Object.keys(ipcWrites)) {
        bridge[channel] = (input?: unknown): Promise<IpcResult<unknown>> => dispatch(channel as IpcChannel, input);
    }
    bridge.on = {
        'timer:tick': (listener: (payload: unknown) => void) => {
            listeners.set('timer:tick', [...(listeners.get('timer:tick') ?? []), listener]);
            return () => {
                listeners.set('timer:tick', (listeners.get('timer:tick') ?? []).filter((e) => e !== listener));
            };
        }
    };
    (globalThis as unknown as Record<string, unknown>)[API_BRIDGE_KEY] = bridge;

    // app/providers mounts this for the whole document, not for the Home route (CR-01).
    disposers.push(subscribeTimerTicks(setTimerSnapshot));

    return {
        main,
        writes,
        logs,
        persisted: () => persisted,
        jumpWallClock: (ms) => { wall += ms; },
        drive(count) {
            for (let i = 0; i < count; i += 1) {
                mono += TICK_MS;
                wall += TICK_MS;
                scheduled?.();
            }
        },
        screen: () => readTimerSnapshot(),
        async adjust(seconds) {
            const answer = await adjustPendingSaveMutation.mutationFn(seconds);
            adjustPendingSaveMutation.onSuccess(answer);
        },
        async remountHome() {
            const answer = await timerSnapshotQuery.queryFn();
            setTimerSnapshot(answer);
            return answer;
        }
    };
}

/** Home's dial over a snapshot, with the day empty, so savableSeconds is what a save would write and nothing else. */
const dialOf = (snapshot: TimerSnapshot): ReturnType<typeof describeWorkDial> => describeWorkDial({
    dailyTargetSeconds: EIGHT_HOURS,
    loggedSeconds: 0,
    elapsedSeconds: snapshot.elapsedSeconds,
    adjustmentSeconds: snapshot.pendingAdjustmentSeconds,
    running: snapshot.status === 'running',
    nowMs: BEFORE_MIDNIGHT_MS,
    countedOnSelectedDay: true
});

/*
 * The invariant the whole design rests on, and the one Phase 8 refused a channel to protect. A correction is time
 * nobody counted; the moment it reaches the accumulator it is indistinguishable from work, and a relaunch would
 * offer it back as work.
 */
describe('the correction never reaches the accumulator', () => {
    it('leaves the counted seconds exactly where they were', async () => {
        const h = loop();
        h.main.start();
        h.drive(10);

        await h.adjust(HALF_HOUR);

        expect(h.main.snapshot().elapsedSeconds, 'the correction was credited as counted time').toBe(10);
        expect(h.main.snapshot().pendingAdjustmentSeconds).toBe(HALF_HOUR);
    });

    it('is never written to disk, so no launch can restore one', async () => {
        const h = loop();
        h.main.start();
        h.drive(10);
        await h.adjust(HALF_HOUR);
        h.drive(5);

        expect(h.persisted().accumulatedSeconds, 'a corrected duration reached app_state').toBe(15);
        expect(
            h.writes.map((state) => state.accumulatedSeconds),
            'a write carried seconds nobody counted'
        ).not.toContain(15 + HALF_HOUR);
    });

    it('is bounded at both ends against what main itself is holding', async () => {
        const h = loop();
        h.main.start();
        h.drive(10);

        // A correction cannot take the session below zero...
        await h.adjust(-HALF_HOUR);
        expect(h.main.snapshot().pendingAdjustmentSeconds).toBe(-10);
        // ...nor past the day the contract bounds a session at.
        await h.adjust(MAX_SESSION_DURATION_SECONDS);
        expect(h.main.snapshot().pendingAdjustmentSeconds).toBe(MAX_SESSION_DURATION_SECONDS - 10);
        expect(dialOf(h.main.snapshot()).savableSeconds).toBe(MAX_SESSION_DURATION_SECONDS);

        // And a delta the dialog could not have produced is refused at the wire rather than clamped quietly.
        await expect(h.adjust(2 * MAX_SESSION_DURATION_SECONDS)).rejects.toThrow(/Too big/);
    });

    it('adds up, so two quick taps are two corrections', async () => {
        const h = loop();
        h.main.start();
        h.drive(10);

        // Both sent before either answer arrives, which is what six buttons on one dialog invite.
        await Promise.all([h.adjust(HALF_HOUR), h.adjust(HALF_HOUR)]);

        expect(h.main.snapshot().pendingAdjustmentSeconds, 'a tap still in flight was overwritten').toBe(2 * HALF_HOUR);
    });
});

/*
 * The defect the owner had not noticed yet, and the one that costs real time: an adjustment made before a trip to
 * Work History was gone on the way back, with nothing said, and the Save that followed wrote the unadjusted
 * duration. Nothing about the loss was visible, which is what made it worth fixing ahead of the disagreement.
 */
describe('a route change does not lose the correction', () => {
    it('is still there after Home unmounts and mounts again', async () => {
        const h = loop();
        h.main.start();
        h.drive(10);
        await h.adjust(60);
        expect(h.screen()?.pendingAdjustmentSeconds).toBe(60);

        // Work History, for five seconds, and back. A reloaded renderer reads the same way: this is its first read.
        h.drive(5);
        const home = await h.remountHome();

        expect(home.pendingAdjustmentSeconds, 'the correction did not survive a route change').toBe(60);
        expect(home.elapsedSeconds, 'the clock kept counting while Home was away').toBe(15);
        expect(dialOf(home).savableSeconds, 'the save that follows would write the unadjusted duration').toBe(75);
    });

    it('is not state of the route component, which is what a route change discards', () => {
        const source = read(PAGE);
        const tree = ts.createSourceFile(PAGE, source, ts.ScriptTarget.Latest, true, scriptKindFor(PAGE));
        const stateNames = findAll(tree, ts.isVariableDeclaration)
            .filter((declaration) => declaration.initializer !== undefined
                && ts.isCallExpression(declaration.initializer)
                && declaration.initializer.expression.getText(tree) === 'useState')
            .map((declaration) => declaration.name.getText(tree));

        expect(
            stateNames.filter((name) => /adjust/i.test(name)),
            'a correction held in route-component state is a correction a route change discards in silence'
        ).toEqual([]);
        expect(source, 'Home no longer reads the correction from the one place that keeps it')
            .toContain('snapshot?.pendingAdjustmentSeconds');
    });
});

/*
 * What clears it, stated here as well as beside the field in timer.service.ts, because "whatever the implementation
 * happens to do" is not a rule anybody can rely on.
 */
describe('what clears the correction', () => {
    it('a reset, which discards the seconds it was correcting', async () => {
        const h = loop();
        h.main.start();
        h.drive(10);
        await h.adjust(HALF_HOUR);

        expect(h.main.reset().pendingAdjustmentSeconds).toBe(0);
    });

    it('a save, so the remainder is not corrected a second time', async () => {
        const h = loop();
        h.main.start();
        h.drive(60);
        await h.adjust(HALF_HOUR);

        // The row took half the counted seconds; the other half is still held (CR-01).
        h.main.creditSaved(30);

        expect(h.main.snapshot().elapsedSeconds).toBe(30);
        expect(h.main.snapshot().pendingAdjustmentSeconds, 'the correction would be applied to the remainder too')
            .toBe(0);
    });

    it('a mode change, because the correction is not drawn in pomodoro mode (WR-03)', async () => {
        const h = loop();
        h.main.start();
        h.drive(10);
        await h.adjust(HALF_HOUR);

        expect(h.main.setMode('pomodoro').pendingAdjustmentSeconds).toBe(0);
        expect(h.main.snapshot().elapsedSeconds, 'CB-1: a mode change still touches no counted second').toBe(10);
    });

    it('a relaunch, which restores the seconds and no correction with them', async () => {
        const first = loop();
        first.main.start();
        first.drive(10);
        await first.adjust(HALF_HOUR);
        first.main.pause();

        const next = loop(first.persisted());

        expect(next.main.snapshot().elapsedSeconds, 'G3/G4: the counted seconds are offered again').toBe(10);
        expect(next.main.snapshot().pendingAdjustmentSeconds, 'a stale correction came back from a previous launch')
            .toBe(0);
    });

    /*
     * Midnight does NOT clear it. The accumulation survives a day boundary and stays savable on the day it was
     * worked (CR-01), so a correction made at 23:50 belongs to that same pending save. Clearing it here would be
     * the original defect again, with a clock for a trigger instead of a route change.
     */
    it('not midnight, which the accumulation itself survives', async () => {
        const h = loop();
        h.main.start();
        h.drive(5);
        await h.adjust(HALF_HOUR);

        // Past local midnight, a second at a time, so the service's own day-rollover branch runs.
        h.drive(10);

        expect(h.main.snapshot().pendingAdjustmentSeconds, 'a day boundary discarded a correction silently')
            .toBe(HALF_HOUR);
        expect(h.main.snapshot().elapsedSeconds).toBe(15);
    });
});

/*
 * The disagreement the owner reported. They pressed Adjust, added a minute, and the dial read REMAINING 07:58:50
 * against an eight-hour target - seventy seconds accounted for - while the tray panel open beside it read
 * 00:00:10. Two surfaces, one timer, two numbers.
 *
 * These are not two assertions about two numbers that happen to match: the point is that both surfaces read the
 * same two snapshot fields through the same savableSeconds, so there is nothing left for them to drift on.
 */
describe('the two surfaces show one timer', () => {
    /** The owner's exact case: ten seconds counted, one minute added, nothing on disk for the day. */
    const OWNERS_CASE: TimerSnapshot = {
        status: 'paused',
        mode: 'work',
        elapsedSeconds: 10,
        restoredFromPreviousLaunch: false,
        persistFailing: false,
        pendingAdjustmentSeconds: 60
    };

    it('reads 00:01:10 on the panel, which is the 70 seconds the dial accounts for', () => {
        const dial = dialOf(OWNERS_CASE);
        const panel = describePanelTimer(OWNERS_CASE);

        expect(dial.savableSeconds, 'the dial accounts for the counted seconds plus the correction').toBe(70);
        expect(dial.digits, 'REMAINING 07:58:50 of an eight-hour target').toEqual(['07', '58', '50']);
        expect(panel.elapsed, 'the panel showed 00:00:10 beside a dial that had accounted for 70').toBe('00:01:10');
    });

    it('carries Home\'s own note under it, word for word', () => {
        expect(describePanelTimer(OWNERS_CASE).adjustment).toBe('+1 min when you save');
        expect(adjustmentLabel(OWNERS_CASE.pendingAdjustmentSeconds),
            'the panel spells the correction its own way').toBe(describePanelTimer(OWNERS_CASE).adjustment);
    });

    it('agrees with the dial at every correction, positive, negative and absent', () => {
        for (const pendingAdjustmentSeconds of [0, 60, 1800, -1800, -3600, 7200]) {
            const snapshot: TimerSnapshot = { ...OWNERS_CASE, elapsedSeconds: 3600, pendingAdjustmentSeconds };
            expect(
                describePanelTimer(snapshot).elapsed,
                'the panel and the dial disagree at ' + String(pendingAdjustmentSeconds) + 's'
            ).toBe(formatElapsed(dialOf(snapshot).savableSeconds));
        }
    });

    it("measures the day with the same total the dial's ring does", () => {
        const snapshot: TimerSnapshot = { ...OWNERS_CASE, elapsedSeconds: 3600, pendingAdjustmentSeconds: 1800 };
        const dial = dialOf(snapshot);
        const bar = describeProgress(countedTowardToday(snapshot), EIGHT_HOURS);

        expect(countedTowardToday(snapshot)).toBe(dial.savableSeconds);
        // 5400 of 28800 is 18%; the ring draws the same fraction, so the two surfaces claim the same day.
        expect(bar.percentLabel).toBe('18%');
        expect(bar.barPercent).toBeCloseTo((dial.savableSeconds / EIGHT_HOURS) * 100, 10);
    });

    it('offers Save exactly when Home does', () => {
        // Nothing counted and a correction of nothing: neither surface offers to write a zero-second session.
        const empty: TimerSnapshot = { ...OWNERS_CASE, elapsedSeconds: 0, pendingAdjustmentSeconds: 0 };
        expect(describePanelTimer(empty).canSave).toBe(false);
        expect(dialOf(empty).savableSeconds > 0).toBe(false);

        // A minute added with nothing counted is a minute a save would write, on both surfaces.
        const added: TimerSnapshot = { ...OWNERS_CASE, elapsedSeconds: 0, pendingAdjustmentSeconds: 60 };
        expect(describePanelTimer(added).canSave).toBe(true);
        expect(dialOf(added).savableSeconds > 0).toBe(true);
    });

    /*
     * WR-10's other half, kept: in pomodoro mode each completed interval is already a session row, so the panel
     * adds nothing to the day - and main clears the correction on a mode change anyway, so a non-zero one here is
     * a state the app cannot reach. The guard stays because the panel must not depend on that to be honest.
     */
    it('adds nothing in pomodoro mode, correction or no correction', () => {
        const cycle: TimerSnapshot = { ...OWNERS_CASE, mode: 'pomodoro', elapsedSeconds: 900 };
        expect(countedTowardToday(cycle)).toBe(0);
        expect(describePanelTimer(cycle).adjustment).toBeNull();
    });

    it('still shows the save figure the panel raises the main window for', async () => {
        const h = loop();
        h.main.start();
        h.drive(10);
        await h.adjust(60);

        // The panel draws whatever the tick delivered - the same snapshot Home has at that moment.
        const live = h.screen() as TimerSnapshot;
        expect(describePanelTimer(live).elapsed).toBe(formatElapsed(dialOf(live).savableSeconds));
        // PANEL-02 unchanged: its Save writes nothing, it raises the main window with the form.
        expect(read('src/renderer/src/features/panel/PanelPage.tsx')).toContain("showMain.mutate('save')");
    });
});

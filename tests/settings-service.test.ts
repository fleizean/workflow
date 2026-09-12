// CORE-03: the settings boundary. The bounds are the point - a value that would disable the streak, the goal
// notification or the long-break derivation is refused at the write rather than stored and lived with.

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/constants/settings';
import { SettingsSchema } from '@shared/schemas';
import {
    MAX_DAILY_TARGET_SECONDS, MAX_INTERVAL_SECONDS, MAX_SESSIONS_UNTIL_LONG_BREAK, MIN_INTERVAL_SECONDS,
    SETTINGS_BOUNDS, SETTING_KEYS, SettingsValidationError, createSettingsService, validateSettingsPatch
} from '../src/main/services/settings.service';
import type { SettingsService, SettingsStore } from '../src/main/services/settings.service';
import type { Settings } from '../src/shared/types';

// Criterion 3: this suite must pass with electron refusing to load.
vi.mock('electron', () => {
    throw new Error('electron was imported by a module that must load without it');
});

interface Harness {
    readonly service: SettingsService;
    readonly patches: Partial<Settings>[];
    readonly reads: number;
    stored(): Settings;
}

function harness(initial: Partial<Settings> = {}): Harness {
    let current: Settings = { ...DEFAULT_SETTINGS, ...initial };
    const patches: Partial<Settings>[] = [];
    const counters = { reads: 0 };
    const store: SettingsStore = {
        get: () => { counters.reads += 1; return current; },
        update: (patch) => {
            patches.push(patch);
            current = { ...current, ...patch };
            return current;
        }
    };
    return {
        service: createSettingsService(store),
        patches,
        get reads() { return counters.reads; },
        stored: () => current
    };
}

/** What update(patch) did to the store, or the error that stopped it. */
function attempt(h: Harness, patch: Partial<Settings>): SettingsValidationError | null {
    try {
        h.service.update(patch);
        return null;
    } catch (error) {
        if (error instanceof SettingsValidationError) return error;
        throw error;
    }
}

describe('CORE-03: the service covers the ten-key Settings shape and nothing else', () => {
    it('knows exactly the keys the wire schema declares', () => {
        expect([...SETTING_KEYS].sort()).toEqual(Object.keys(SettingsSchema.shape).sort());
    });

    it('bounds every numeric key, so none is written unchecked', () => {
        const numeric = Object.entries(DEFAULT_SETTINGS)
            .filter(([, value]) => typeof value === 'number').map(([key]) => key).sort();
        expect(Object.keys(SETTINGS_BOUNDS).sort()).toEqual(numeric);
    });

    it('admits every shipped default, so a fresh install is not refusing its own seed', () => {
        expect(attempt(harness(), { ...DEFAULT_SETTINGS })).toBeNull();
    });

    it('reads through to the repository rather than caching', () => {
        const h = harness();
        h.service.get();
        h.service.get();
        expect(h.reads).toBe(2);
    });
});

describe('CORE-03: a patch writes only the keys it sets', () => {
    it('passes the set keys through and leaves the rest alone', () => {
        const h = harness();
        const after = h.service.update({ dailyTargetSeconds: 21600 });
        expect(h.patches).toEqual([{ dailyTargetSeconds: 21600 }]);
        expect(after.pomodoroWorkSeconds).toBe(DEFAULT_SETTINGS.pomodoroWorkSeconds);
    });

    it('treats an explicitly undefined key as absent rather than as a write', () => {
        const h = harness();
        h.service.update({ dailyTargetSeconds: undefined, pomodoroEnabled: true });
        expect(h.patches).toEqual([{ pomodoroEnabled: true }]);
    });

    it('writes nothing for an empty patch and still answers with the current settings', () => {
        const h = harness({ dailyTargetSeconds: 3600 });
        expect(h.service.update({}).dailyTargetSeconds).toBe(3600);
        expect(h.patches, 'an unchanged form opened a write transaction').toEqual([]);
    });
});

describe('CORE-03: a nonsensical value is refused, not stored', () => {
    const durationKeys = [
        'pomodoroWorkSeconds', 'pomodoroShortBreakSeconds', 'pomodoroLongBreakSeconds'
    ] as const;

    it.each(durationKeys)('refuses a zero %s', (key) => {
        const h = harness();
        expect(attempt(h, { [key]: 0 })?.key).toBe(key);
        expect(h.patches, 'the refused value reached the repository').toEqual([]);
    });

    it.each(durationKeys)('refuses a negative %s', (key) => {
        expect(attempt(harness(), { [key]: -1500 })?.key).toBe(key);
    });

    it.each(durationKeys)('refuses a %s longer than four hours', (key) => {
        expect(attempt(harness(), { [key]: MAX_INTERVAL_SECONDS + 1 })?.key).toBe(key);
        expect(attempt(harness(), { [key]: MAX_INTERVAL_SECONDS }), 'the cap itself is allowed').toBeNull();
    });

    it.each(durationKeys)('refuses a %s shorter than a minute, and allows a minute exactly', (key) => {
        expect(attempt(harness(), { [key]: MIN_INTERVAL_SECONDS - 1 })?.key).toBe(key);
        expect(attempt(harness(), { [key]: MIN_INTERVAL_SECONDS })).toBeNull();
    });

    it('refuses a daily target of zero, which would report the goal met before any work', () => {
        expect(attempt(harness(), { dailyTargetSeconds: 0 })?.key).toBe('dailyTargetSeconds');
    });

    it('refuses a daily target longer than a day, which no day could ever meet', () => {
        expect(attempt(harness(), { dailyTargetSeconds: MAX_DAILY_TARGET_SECONDS + 1 })?.key)
            .toBe('dailyTargetSeconds');
        expect(attempt(harness(), { dailyTargetSeconds: MAX_DAILY_TARGET_SECONDS })).toBeNull();
    });

    it('refuses a long-break cycle of zero, which the derivation would divide by', () => {
        // completedToday % 0 is NaN, so this is the one bound that is a correctness requirement, not a judgement.
        expect(attempt(harness(), { pomodoroSessionsUntilLongBreak: 0 })?.key)
            .toBe('pomodoroSessionsUntilLongBreak');
        expect(attempt(harness(), { pomodoroSessionsUntilLongBreak: 1 }), 'a long break every pomodoro is legitimate')
            .toBeNull();
    });

    it('refuses a long-break cycle no working day could finish', () => {
        expect(attempt(harness(), { pomodoroSessionsUntilLongBreak: MAX_SESSIONS_UNTIL_LONG_BREAK + 1 })?.key)
            .toBe('pomodoroSessionsUntilLongBreak');
    });

    it.each([
        ['a fraction', 1500.5],
        ['not a number at all', '1500'],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['null', null]
    ])('refuses a duration that is %s', (_label, value) => {
        const h = harness();
        expect(attempt(h, { pomodoroWorkSeconds: value } as Partial<Settings>)?.key).toBe('pomodoroWorkSeconds');
        expect(h.patches).toEqual([]);
    });

    it('refuses a boolean setting that is not a boolean', () => {
        // v1.2.1 stored every setting as a string, so 'false' is exactly what a careless caller would send - and
        // String('false') is truthy, which is how a disabled feature turns itself back on.
        const h = harness();
        expect(attempt(h, { goalNotification: 'false' } as unknown as Partial<Settings>)?.key)
            .toBe('goalNotification');
        expect(h.patches).toEqual([]);
    });

    it('refuses a key this app does not have, naming it', () => {
        // script_url and export_half_hour_precision still sit in the table the owner stopped using (slice A).
        const error = attempt(harness(), { script_url: 'https://example.test' } as unknown as Partial<Settings>);
        expect(error?.key).toBe('script_url');
        expect(error?.message).toContain('script_url');
    });

    it('refuses the whole patch when one key is wrong, so nothing half-applies', () => {
        const h = harness();
        expect(attempt(h, { dailyTargetSeconds: 21600, pomodoroWorkSeconds: 0 })?.key).toBe('pomodoroWorkSeconds');
        expect(h.patches, 'the good half of a refused patch was written').toEqual([]);
        expect(h.stored().dailyTargetSeconds).toBe(DEFAULT_SETTINGS.dailyTargetSeconds);
    });

    it('says what it refused and what it wanted', () => {
        const error = attempt(harness(), { pomodoroWorkSeconds: 10 });
        expect(error?.message).toContain('pomodoroWorkSeconds');
        expect(error?.message).toContain(String(MIN_INTERVAL_SECONDS));
        expect(error?.message).toContain('10');
    });

    it('validates without a store at all, so a caller can check a form before submitting it', () => {
        expect(validateSettingsPatch({ dailyTargetSeconds: 3600 })).toEqual({ dailyTargetSeconds: 3600 });
        expect(() => validateSettingsPatch({ dailyTargetSeconds: 1 })).toThrow(SettingsValidationError);
    });
});

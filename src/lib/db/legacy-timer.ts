// Parses v1.2.1's localStorage timerState string (D-34). It never throws, and the time the app was closed is
// never added: lastUpdated is carried over, never computed with (B12).

import { utcIsoTimestamp } from '@shared/utils/date';

export interface LegacyTimerRecord {
    readonly raw: string;
    readonly elapsedSeconds: number | null;
    readonly wasRunning: boolean | null;
    readonly pomodoroMode: boolean | null;
    readonly pomodoroState: string | null;
    readonly pomodoroSessionCount: number | null;
    readonly lastUpdated: number | null;
    readonly importedAt: string;
}

const asBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// A whole non-negative count; 2**53 and 1e308 both fall outside the safe range.
const asCount = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

// v1.2.1 can save a fractional second, so this floors; non-finite, negative or unsafe values are dropped.
const asSeconds = (value: unknown): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
        return null;
    }
    return Math.floor(value);
};

// Garbage, a non-object and a non-JSON string all yield no fields, which leaves every mapped value null.
function fieldsOf(raw: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {};
    }
    return parsed as Record<string, unknown>;
}

/** `now` names the import instant only; it never reaches elapsedSeconds. The raw string is always kept verbatim. */
export function parseLegacyTimerState(raw: string, now: Date): LegacyTimerRecord {
    const saved = fieldsOf(raw);
    return Object.freeze({
        raw,
        elapsedSeconds: asSeconds(saved['elapsed']),
        wasRunning: asBoolean(saved['running']),
        pomodoroMode: asBoolean(saved['pomodoroMode']),
        pomodoroState: asString(saved['pomodoroState']),
        pomodoroSessionCount: asCount(saved['pomodoroSessionCount']),
        lastUpdated: asCount(saved['lastUpdated']),
        importedAt: utcIsoTimestamp(now)
    });
}

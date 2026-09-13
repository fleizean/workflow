// Elapsed seconds as HH:MM:SS, the way v1.2.1's clock read. Integer arithmetic only: a duration is not a calendar
// date, and routing it through Date would drag in the UTC-day trap SHARED-03 exists to keep out.

const TWO_DIGITS = 2;
const PAD = '0';

export function formatElapsed(totalSeconds: number): string {
    const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    return [hours, minutes, seconds].map((part) => String(part).padStart(TWO_DIGITS, PAD)).join(':');
}

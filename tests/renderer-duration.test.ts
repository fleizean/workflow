/*
 * A duration is an integer number of seconds, and it never becomes a float to get from one place to another.
 *
 * TIMER CR-02 and SCREENS BL-01 were one defect wearing two faces: both forms rendered the stored seconds as
 * `(seconds / 3600).toFixed(n)` and read them back as `Math.floor(parseFloat(text) * 3600)`, so a save quantised
 * to 36-second steps and an edit to six-minute steps. Editing a session's NOTE rewrote its duration, because the
 * whole row went back through that round trip.
 *
 * The rule pinned here is the one the settings draft already follows - a field nobody typed into is never written
 * - applied to time.
 */

import { describe, expect, it } from 'vitest';
import {
    MINUTES_PER_HOUR, durationFields, parseDurationFields, reviewDuration, seedDuration
} from '@renderer/lib/duration';
import { MAX_SESSION_DURATION_SECONDS } from '@shared/constants/sessions';

describe('durationFields: what the two boxes show', () => {
    it('splits whole hours and whole minutes', () => {
        expect(durationFields(4980)).toEqual({ hours: '1', minutes: '23' });
        expect(durationFields(1500)).toEqual({ hours: '0', minutes: '25' });
        expect(durationFields(0)).toEqual({ hours: '0', minutes: '0' });
    });

    it('truncates the seconds it cannot show rather than rounding them up', () => {
        // 3661 s is 1h 1m 1s. The box says 1h 1m; the second is kept by seedDuration, not by the display.
        expect(durationFields(3661)).toEqual({ hours: '1', minutes: '1' });
        expect(durationFields(3659)).toEqual({ hours: '1', minutes: '0' });
        expect(durationFields(3599)).toEqual({ hours: '0', minutes: '59' });
    });

    it('reads a negative or unreadable duration as nothing', () => {
        expect(durationFields(-1)).toEqual({ hours: '0', minutes: '0' });
        expect(durationFields(Number.NaN)).toEqual({ hours: '0', minutes: '0' });
    });
});

describe('parseDurationFields: what the two boxes mean', () => {
    it('adds the two units as whole numbers', () => {
        expect(parseDurationFields({ hours: '1', minutes: '23' })).toBe(4980);
        expect(parseDurationFields({ hours: '0', minutes: '25' })).toBe(1500);
    });

    it('treats an empty box as none of that unit, because a blank is not a refusal', () => {
        expect(parseDurationFields({ hours: '', minutes: '45' })).toBe(2700);
        expect(parseDurationFields({ hours: '2', minutes: '' })).toBe(7200);
    });

    it('refuses anything that is not a whole number, so no float ever reaches a duration', () => {
        expect(parseDurationFields({ hours: '1.5', minutes: '0' })).toBeNull();
        expect(parseDurationFields({ hours: '1', minutes: '2.5' })).toBeNull();
        expect(parseDurationFields({ hours: 'e', minutes: '0' })).toBeNull();
        expect(parseDurationFields({ hours: '-1', minutes: '0' })).toBeNull();
    });

    it('refuses a minutes box outside the 0-59 its own max attribute states', () => {
        expect(parseDurationFields({ hours: '0', minutes: String(MINUTES_PER_HOUR) })).toBeNull();
        expect(parseDurationFields({ hours: '0', minutes: '59' })).toBe(3540);
    });
});

describe('reviewDuration: an edit that does not touch the duration writes the same duration', () => {
    /* The whole of BL-01. Every row here is a real stored value the two screens produce. */
    const untouched = [3661, 4980, 1500, 4500, 7261, 100, 1, MAX_SESSION_DURATION_SECONDS];

    it.each(untouched)('writes %i seconds back byte-identical when the boxes were not typed into', (seconds) => {
        const seed = seedDuration(seconds);
        expect(reviewDuration(seed.fields, seed)).toEqual({ seconds, refusal: null });
    });

    it('writes what the user typed once a box changes', () => {
        const seed = seedDuration(4980);
        expect(reviewDuration({ hours: '2', minutes: '23' }, seed)).toEqual({ seconds: 8580, refusal: null });
        expect(reviewDuration({ hours: '1', minutes: '30' }, seed)).toEqual({ seconds: 5400, refusal: null });
    });

    it('refuses a duration of nothing rather than writing a zero-second session', () => {
        const seed = seedDuration(0);
        expect(reviewDuration({ hours: '0', minutes: '0' }, seed).seconds).toBeNull();
        expect(reviewDuration({ hours: '0', minutes: '0' }, seed).refusal).toBeTypeOf('string');
    });

    it('refuses a duration longer than the day the contract bounds a session at', () => {
        const seed = seedDuration(0);
        const over = reviewDuration({ hours: '25', minutes: '0' }, seed);
        expect(over.seconds).toBeNull();
        expect(over.refusal).toContain('24');
    });

    it('accepts exactly the contract bound, because a timer left running across a weekend reaches it', () => {
        const seed = seedDuration(0);
        expect(reviewDuration({ hours: '24', minutes: '0' }, seed).seconds).toBe(MAX_SESSION_DURATION_SECONDS);
    });

    it('refuses an unreadable box instead of silently reading it as zero', () => {
        const seed = seedDuration(3600);
        const refused = reviewDuration({ hours: '1.5', minutes: '0' }, seed);
        expect(refused.seconds).toBeNull();
        expect(refused.refusal).toBeTypeOf('string');
    });
});

describe('what the old representation did, as the control', () => {
    /*
     * These are the numbers both reviewers reproduced. They are asserted as arithmetic rather than by calling the
     * deleted code, so the file states plainly what the new representation had to stop doing.
     */
    it('lost or invented up to three minutes per edit at one decimal place', () => {
        const roundTrip = (seconds: number): number =>
            Math.floor((Number.parseFloat((seconds / 3600).toFixed(1)) || 0) * 3600);
        expect(roundTrip(4980)).toBe(5040);
        expect(roundTrip(1500)).toBe(1440);
        expect(roundTrip(4500)).toBe(4680);
        expect(roundTrip(100)).toBe(0);
    });

    it('quantised every save to 36-second steps at two decimal places', () => {
        const roundTrip = (seconds: number): number =>
            Math.floor((Number.parseFloat((seconds / 3600).toFixed(2)) || 0) * 3600);
        expect(roundTrip(3661)).toBe(3672);
        expect(roundTrip(7271)).toBe(7272);
    });

    it('is not what the new representation does with the same values', () => {
        for (const seconds of [4980, 1500, 4500, 100, 3661, 7271]) {
            const seed = seedDuration(seconds);
            expect(reviewDuration(seed.fields, seed).seconds).toBe(seconds);
        }
    });
});

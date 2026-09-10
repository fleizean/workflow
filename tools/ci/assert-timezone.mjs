#!/usr/bin/env node
/*
 * BUILD-11 - prove that a CI timezone-matrix leg actually runs in the zone it is labelled with.
 *
 * The failure this prevents: a matrix leg sets a variable the runtime never honours, every date test
 * in it runs in the runner's default zone, the leg passes green, and the run reports that three
 * timezones were covered when one was. That is a worse outcome than having no matrix at all. The
 * roadmap counts on this matrix to make Phase 3's date module falsifiable: the author is in UTC+3 and
 * Turkey has observed no DST since 2016, so the whole bug class this milestone closes - B6 through
 * B10 and the Google Sheets row misalignment - cannot be reproduced on the author's machine. A leg
 * that silently stays in one zone would let exactly that class through while claiming the DST case
 * was tested.
 *
 * This is not hypothetical. Measured while writing this file, on the author's Windows machine under
 * Git Bash: `TZ=UTC node ...` reached Node, but `TZ=America/New_York node ...`,
 * `TZ=Europe/Istanbul node ...` and `TZ=Etc/UTC node ...` all arrived with process.env.TZ undefined,
 * and Node fell back to the machine zone without a word. The requested zone and the zone the code
 * ran in differed, and nothing said so.
 *
 * So each leg asserts three things, and any one failing fails the leg:
 *
 *   1. resolved zone - the zone the runtime's own Intl API reports equals the expected name;
 *   2. TZ variable   - the variable that requests the zone is set to that same name, so a mismatch
 *                      between what was asked for and what the runtime resolved is visible rather
 *                      than silent (a leg running on a machine that happens to be in the right zone
 *                      would otherwise pass while proving nothing about the matrix);
 *   3. offsets       - a fixed January instant and a fixed July instant produce the offsets
 *                      documented for that zone in ZONE_OFFSETS below. This is the check that
 *                      exercises the zone rules rather than trusting a name.
 *
 * A zone with no row in ZONE_OFFSETS is itself a failure: adding a fourth zone to the matrix without
 * documenting its offsets here goes red instead of passing unchecked.
 *
 * Do not "fix" a failing leg by assigning process.env.TZ in this script or in a test setup file.
 * Node re-reads the variable on assignment, so that would turn every leg green by construction and
 * delete the only evidence that the matrix works.
 *
 * Usage:
 *   node tools/ci/assert-timezone.mjs <IANA zone>     e.g. America/New_York
 *
 * Exit codes: 0 every assertion held, 1 an assertion failed, 2 no zone argument was given.
 *
 * Phase 3 owns the date module this matrix exists to falsify; ZONE_OFFSETS and checkTimezone() are
 * exported so its tests can reuse the same table instead of re-deriving it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'tools/ci/assert-timezone.mjs';

/*
 * Two fixed instants, mid-month at midday UTC, so they sit well away from every DST transition in
 * every zone in the table - an offset mismatch here is a zone mismatch, never an edge case.
 */
export const JANUARY_INSTANT = Date.UTC(2026, 0, 15, 12, 0, 0);
export const JULY_INSTANT = Date.UTC(2026, 6, 15, 12, 0, 0);

/*
 * Offsets in minutes, in the sign convention of Date.prototype.getTimezoneOffset(): positive WEST
 * of UTC. New York is UTC-5 in winter and UTC-4 in summer, so it reads 300 then 240. Istanbul is
 * UTC+3 all year, so it reads -180 twice.
 *
 * The three rows are BUILD-11's floor, not an arbitrary sample:
 *   UTC              - the reference zone, where local and UTC dates never disagree;
 *   America/New_York - DST-observing, negative UTC offset: the case where the local day and the UTC
 *                      day differ in the evening and shift by an hour twice a year;
 *   Europe/Istanbul  - non-DST, positive UTC offset, the author's own zone: the case where
 *                      toISOString() reports the previous day for the first three hours of every day.
 */
export const ZONE_OFFSETS = Object.freeze({
    'UTC': Object.freeze({ january: 0, july: 0 }),
    'America/New_York': Object.freeze({ january: 300, july: 240 }),
    'Europe/Istanbul': Object.freeze({ january: -180, july: -180 }),
    // Zone-sweep rows for tests/date-zone-sweep.test.ts (Phase 3 D-07/D-08), not CI legs.
    'America/Santiago': Object.freeze({ january: 180, july: 240 }),
    'Pacific/Kiritimati': Object.freeze({ january: -840, july: -840 }),
    'Pacific/Pago_Pago': Object.freeze({ january: 660, july: 660 }),
    'Etc/GMT+12': Object.freeze({ january: 720, july: 720 }),
    'Asia/Kolkata': Object.freeze({ january: -330, july: -330 }),
    'Asia/Kathmandu': Object.freeze({ january: -345, july: -345 }),
    'Australia/Lord_Howe': Object.freeze({ january: -660, july: -630 }),
    'Pacific/Auckland': Object.freeze({ january: -780, july: -720 }),
    'Pacific/Chatham': Object.freeze({ january: -825, july: -765 })
});

/* What the running process actually reports. Injectable so checkTimezone() stays a pure function. */
export function runtimeProbe(env = process.env) {
    return {
        resolvedZone: String(Intl.DateTimeFormat().resolvedOptions().timeZone),
        tzVariable: env.TZ,
        offsetAt: (instant) => new Date(instant).getTimezoneOffset()
    };
}

/*
 * Check one expected zone against a probe. Returns every assertion's outcome - not just the first
 * failure - so a leg that is wrong in two ways says so in one run.
 */
export function checkTimezone(expectedZone, probe = runtimeProbe()) {
    const results = [];

    results.push({
        label: 'resolved zone',
        ok: probe.resolvedZone === expectedZone,
        detail: 'Intl reports ' + probe.resolvedZone + ', expected ' + expectedZone
    });

    results.push({
        label: 'TZ variable',
        ok: probe.tzVariable === expectedZone,
        detail: probe.tzVariable === undefined
            ? 'TZ is not set in this process, expected TZ=' + expectedZone
            : 'TZ=' + probe.tzVariable + ', expected TZ=' + expectedZone
    });

    const january = probe.offsetAt(JANUARY_INSTANT);
    const july = probe.offsetAt(JULY_INSTANT);
    const documented = Object.prototype.hasOwnProperty.call(ZONE_OFFSETS, expectedZone)
        ? ZONE_OFFSETS[expectedZone]
        : null;

    if (documented === null) {
        results.push({
            label: 'offsets',
            ok: false,
            detail: 'no documented offsets for ' + expectedZone + ' - add a row to ZONE_OFFSETS in ' +
                SCRIPT_NAME + ' before adding the zone to the matrix (observed january=' + january +
                ' july=' + july + ')'
        });
    } else {
        results.push({
            label: 'offsets',
            ok: january === documented.january && july === documented.july,
            detail: new Date(JANUARY_INSTANT).toISOString() + ' -> ' + january + ' min (expected ' +
                documented.january + '); ' + new Date(JULY_INSTANT).toISOString() + ' -> ' + july +
                ' min (expected ' + documented.july + ')'
        });
    }

    return {
        ok: results.every((r) => r.ok),
        zone: expectedZone,
        january,
        july,
        results
    };
}

export function formatReport(outcome) {
    const lines = outcome.results.map((r) =>
        SCRIPT_NAME + ': [' + (r.ok ? 'PASS' : 'FAIL') + '] ' + r.label.padEnd(13) + ' ' + r.detail);
    if (outcome.ok) {
        lines.push('TIMEZONE_OK ' + outcome.zone + ' january=' + outcome.january + ' july=' + outcome.july);
    } else {
        const failed = outcome.results.filter((r) => !r.ok).map((r) => r.label).join(', ');
        lines.push(
            '::error::TIMEZONE_MISMATCH ' + outcome.zone + ' - failed: ' + failed + '. This leg did ' +
            'not run in the zone it is labelled with, so its date tests prove nothing about that zone.'
        );
    }
    return lines.join('\n');
}

/* ---------------------------------------------------------------------------------------- */
/* CLI                                                                                        */
/* ---------------------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const expected = process.argv[2];
    if (!expected) {
        console.error(SCRIPT_NAME + ': usage: node ' + SCRIPT_NAME + ' <IANA zone>, e.g. America/New_York');
        console.error(SCRIPT_NAME + ': documented zones: ' + Object.keys(ZONE_OFFSETS).join(', '));
        process.exitCode = 2;
    } else {
        const outcome = checkTimezone(expected);
        const report = formatReport(outcome);
        // exitCode rather than process.exit(): a pending write to a Windows pipe is not flushed by
        // an immediate exit, and the report is the whole point of a failing leg.
        if (outcome.ok) {
            console.log(report);
        } else {
            console.error(report);
            process.exitCode = 1;
        }
    }
}

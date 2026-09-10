// Zone sweep (SHARED-01/02, D-07..D-09): each child is spawned with an explicit TZ and proves its zone by offsets.
// The zone is set at spawn only; assigning process.env.TZ would turn the sweep green by construction.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZONE_OFFSETS } from '../tools/ci/assert-timezone.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(repoRoot, 'tests', 'fixtures', 'date-sweep-child.mjs');

// Every D-07 class, with both options for UTC-11/-12 and for southern-hemisphere DST.
const SWEEP_ZONES = [
    'UTC',
    'America/New_York',
    'Europe/Istanbul',
    'America/Santiago',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
    'Etc/GMT+12',
    'Asia/Kolkata',
    'Asia/Kathmandu',
    'Australia/Lord_Howe',
    'Pacific/Auckland',
    'Pacific/Chatham'
];
const DST_ZONES = new Set(['America/New_York', 'America/Santiago', 'Australia/Lord_Howe', 'Pacific/Auckland', 'Pacific/Chatham']);
const CORRECT = { fall: '2026-11-02', spring: '2026-03-02', fallBucket: 'lastWeek', springBucket: 'lastWeek' };

interface SweepReport {
    zone: string;
    resolved: string;
    january: number;
    july: number;
    daysChecked: number;
    roundTripFailures: string[];
    arithmeticFailures: string[];
    weekdayFailures: string[];
    transitionDays: number;
    skippedMidnights: number;
    hourlyChecks: number;
    hourlyFailures: string[];
    oracleError: string | null;
    naive: { fall: string; spring: string; fallBucket: string };
    correct: { fall: string; spring: string; fallBucket: string; springBucket: string };
}

interface ChildRun {
    report: SweepReport;
    stderr: string;
}

function runChild(zone: string): ChildRun {
    const env: NodeJS.ProcessEnv = { ...process.env, TZ: zone };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const run = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', CHILD, zone], {
        env,
        encoding: 'utf8',
        timeout: 60_000
    });
    if (run.status !== 0) {
        throw new Error(zone + ': sweep child exited ' + String(run.status) + '\n' + run.stderr);
    }
    return { report: JSON.parse(run.stdout) as SweepReport, stderr: run.stderr };
}

// One spawn per zone, whichever test asks first.
const runs = new Map<string, ChildRun>();
function reportFor(zone: string): ChildRun {
    let run = runs.get(zone);
    if (run === undefined) {
        run = runChild(zone);
        runs.set(zone, run);
    }
    return run;
}

describe('date.ts zone sweep', () => {
    it('every sweep zone has a documented ZONE_OFFSETS row (D-08: rows first)', () => {
        const missing = SWEEP_ZONES.filter((zone) => !Object.prototype.hasOwnProperty.call(ZONE_OFFSETS, zone));
        expect(missing, 'add these to tools/ci/assert-timezone.mjs').toEqual([]);
    });

    it.each(SWEEP_ZONES)('%s: proves its zone by offsets and holds every invariant', (zone) => {
        const { report, stderr } = reportFor(zone);

        expect(stderr, 'the child must write nothing to stderr').toBe('');
        expect(report.zone, 'the child reports the zone it was asked for').toBe(zone);
        // Never compare names: ICU aliases Asia/Kolkata to Asia/Calcutta and Asia/Kathmandu to Asia/Katmandu.
        expect(report.resolved, 'Etc/Unknown means the child fell back silently (D-08)').not.toBe('Etc/Unknown');
        expect({ january: report.january, july: report.july }, zone + ' offsets (D-08)').toEqual(ZONE_OFFSETS[zone]);
        expect(report.daysChecked, '2020-2030 has 4018 days').toBe(4018);
        expect(report.roundTripFailures, 'SHARED-01 round trip').toEqual([]);
        expect(report.arithmeticFailures, 'SHARED-02 addDays/diffDays stepping').toEqual([]);
        expect(report.weekdayFailures, 'SHARED-02 isoWeekday against getDay').toEqual([]);
        expect(report.oracleError, 'the Intl oracle must accept the zone name').toBeNull();
        expect(report.hourlyFailures, 'SHARED-01 hourly walk against the Intl oracle').toEqual([]);
        if (DST_ZONES.has(zone)) {
            expect(report.transitionDays, zone + ' observes DST in 2020-2030').toBeGreaterThan(0);
            expect(report.hourlyChecks, 'the hourly walk must run in a DST zone').toBeGreaterThan(0);
        } else {
            expect(report.transitionDays, zone + ' has no DST in 2020-2030').toBe(0);
        }
        if (zone === 'America/Santiago') {
            expect(report.skippedMidnights, 'Santiago skips local midnight (D-03)').toBeGreaterThan(0);
        }
        expect(report.correct, 'SHARED-02: date.ts week arithmetic across the 169- and 167-hour weeks').toEqual(CORRECT);
    }, 120_000);

    it('D-09 counterexample: the naive epoch-millisecond week is wrong in America/New_York', () => {
        const { naive } = reportFor('America/New_York').report;
        const vacuous = 'if the naive implementation ever passes here the child is not in a DST zone and the proof is vacuous';
        expect(naive.fall, '169-hour week: ' + vacuous).toBe('2026-11-01');
        expect(naive.spring, '167-hour week: ' + vacuous).toBe('2026-03-01');
        expect(naive.fallBucket, 'instant-form bucket puts Mon 2026-10-26 in older: ' + vacuous).toBe('older');
    }, 120_000);

    it('D-09 control: in UTC the naive week agrees with date.ts, so the failure belongs to the zone', () => {
        const { naive } = reportFor('UTC').report;
        expect(naive, 'naive arithmetic is only wrong where days are not 24 hours long')
            .toEqual({ fall: CORRECT.fall, spring: CORRECT.spring, fallBucket: CORRECT.fallBucket });
    }, 120_000);

    it('D-08 control: an unknown TZ falls back to Etc/Unknown, so the detector has teeth', () => {
        const { report } = runChild('Not/A_Zone');
        expect(report.resolved, 'the fallback must be detectable by name').toBe('Etc/Unknown');
        expect({ january: report.january, july: report.july }, 'a fallback is indistinguishable from UTC by offsets alone')
            .toEqual(ZONE_OFFSETS['UTC']);
    }, 120_000);
});

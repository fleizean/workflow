// Zone sweep (SHARED-01/02, D-07..D-09): each child is spawned with an explicit TZ and proves its zone by offsets.
// The zone is set at spawn only; assigning process.env.TZ would turn the sweep green by construction.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZONE_OFFSETS } from '../tools/ci/assert-timezone.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = path.join(repoRoot, 'tests', 'fixtures', 'date-sweep-child.mjs');

interface SweepReport {
    zone: string;
    resolved: string;
    january: number;
    july: number;
    daysChecked: number;
    roundTripFailures: string[];
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

describe('date.ts zone sweep', () => {
    it('America/New_York: the child is in the zone it was spawned into and round-trips 2020-2030', () => {
        const zone = 'America/New_York';
        const { report, stderr } = runChild(zone);
        const row = ZONE_OFFSETS[zone];

        expect(stderr, 'the child must write nothing to stderr').toBe('');
        expect(report.resolved, 'Etc/Unknown means the child fell back silently (D-08)').not.toBe('Etc/Unknown');
        expect(row, 'every sweep zone needs a ZONE_OFFSETS row first (D-08)').toBeDefined();
        expect({ january: report.january, july: report.july }, zone + ' offsets (D-08)').toEqual(row);
        expect(report.daysChecked, '2020-2030 has 4018 days').toBe(4018);
        expect(report.roundTripFailures, 'SHARED-01 round trip in ' + zone).toEqual([]);
    }, 120_000);
});

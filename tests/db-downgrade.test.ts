// D-26/X5: after every corpus fixture reaches LATEST, v1.2.1's own SQL still runs against it - its init path,
// its writes and its reads - and the rows it writes read back. v1.2.1 never touches user_version.

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import type { MigrationReport } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import { cleanupFixtures, copyFixture } from './fixtures/seed';
import { LEGACY_CORPUS, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
import { runV121Downgrade } from './helpers/v121-sql';

const TODAY = '2026-01-05';
const NOW = new Date(2026, 5, 1, 9, 0, 0);

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-downgrade-' + tag + '-'));
    tempDirs.push(dir);
    return dir;
}

afterAll(() => {
    cleanupFixtures();
    cleanupLegacyFixtures();
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// The production defaults: no steps and no baseline are injected.
async function migrateReal(dbPath: string): Promise<MigrationReport> {
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    const db = openDatabase(dbPath);
    try {
        return await migrateDatabase(db, {
            dbPath,
            dbClass: classify(probe.observed, LATEST),
            fromVersion: probe.observed.userVersion,
            backupDir: path.join(path.dirname(dbPath), 'backups'),
            now: NOW
        });
    } finally {
        closeDatabase(db);
    }
}

// v1.2.1 reinstalled over a migrated database: its own statements, against the real schema.
function downgradeOver(dbPath: string): readonly string[] {
    const db = openDatabase(dbPath);
    try {
        return runV121Downgrade(db, TODAY).failures;
    } finally {
        closeDatabase(db);
    }
}

async function proveDowngrade(id: string, dbPath: string): Promise<void> {
    const report = await migrateReal(dbPath);
    expect(report.toVersion, id).toBe(LATEST);

    expect(downgradeOver(dbPath), id + ': v1.2.1 statements that failed').toEqual([]);

    // v1.2.1 has no notion of user_version, so the file still reads as current afterwards.
    const probe = probeDatabase(dbPath);
    expect(probe.ok, id).toBe(true);
    if (!probe.ok) return;
    expect(probe.observed.userVersion, id + ': v1.2.1 must not move the version').toBe(LATEST);
    expect(classify(probe.observed, LATEST), id).toBe('current');

    // And the next launch of this milestone has nothing left to do.
    const again = await migrateReal(dbPath);
    expect(again.applied, id + ': a second run applies nothing').toEqual([]);
    expect(again.backupPath, id + ': and takes no backup').toBeNull();
}

describe('D-26: v1.2.1 still works on a database this milestone migrated', () => {
    it('a fresh install survives a v1.2.1 reinstall', async () => {
        await proveDowngrade('fresh', path.join(tempDir('fresh'), 'krono.db'));
    });

    it.each(LEGACY_CORPUS.map((entry) => [entry.id, entry] as const))(
        '%s survives a v1.2.1 reinstall',
        async (id, entry) => {
            await proveDowngrade(id, copyFixture(await entry.build()));
        },
        120_000
    );
});

// D-24: runs the real chain and blocks at one deterministic kill point so the parent can SIGKILL it there.
// argv: [dbPath, backupDir, killPoint, markerPath]. Bundled by tests/db-kill.test.ts; never imported in-process.

import fs from 'node:fs';
import { classify } from '../../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../../src/lib/db/client';
import { probeDatabase } from '../../src/lib/db/probe';
import { migrateDatabase } from '../../src/lib/db/runner';
import { LATEST } from '../../src/lib/db/migrations/registry';

export type KillPoint = 'baseline-tx' | 'between-v1-v2' | 'v2-tx' | 'backup';

export const KILL_POINTS: readonly KillPoint[] = ['baseline-tx', 'between-v1-v2', 'v2-tx', 'backup'];

const isKillPoint = (value: string): value is KillPoint => (KILL_POINTS as readonly string[]).includes(value);

// The marker is written synchronously BEFORE blocking: a process parked in Atomics.wait never flushes an
// asynchronous IPC message, so process.send could not signal this (RESEARCH Pattern 7).
function parkForever(markerPath: string, point: KillPoint): void {
    fs.writeFileSync(markerPath, point);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('migrate-child: Atomics.wait returned, which it must never do');
}

async function main(): Promise<void> {
    const [dbPath, backupDir, point, markerPath] = process.argv.slice(2);
    if (dbPath === undefined || backupDir === undefined || point === undefined || markerPath === undefined) {
        throw new Error('migrate-child: expected [dbPath, backupDir, killPoint, markerPath]');
    }
    if (!isKillPoint(point)) {
        throw new Error('migrate-child: unknown kill point ' + point);
    }

    const probe = probeDatabase(dbPath);
    if (!probe.ok) {
        throw new Error('migrate-child: probe failed - ' + probe.reason);
    }

    const db = openDatabase(dbPath);
    try {
        await migrateDatabase(db, {
            dbPath,
            dbClass: classify(probe.observed, LATEST),
            fromVersion: probe.observed.userVersion,
            backupDir,
            hooks: {
                insideTransaction: (version) => {
                    if (point === 'baseline-tx' && version === 1) parkForever(markerPath, point);
                    if (point === 'v2-tx' && version === 2) parkForever(markerPath, point);
                },
                afterCommit: (version) => {
                    if (point === 'between-v1-v2' && version === 1) parkForever(markerPath, point);
                },
                onBackupProgress: () => {
                    if (point === 'backup') parkForever(markerPath, point);
                }
            }
        });
    } finally {
        closeDatabase(db);
    }
}

void main();

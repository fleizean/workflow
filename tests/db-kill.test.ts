// D-24/SC2/DATA-09: a SIGKILL at any of the four kill points leaves a database that reopens, passes
// integrity_check, never reports a version whose transaction was cut, keeps its data, and finishes on a re-run.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { build } from 'vite';
import { PENDING_SUFFIX, verifyBackup } from '../src/lib/db/backup';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import type { MigrationReport } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import { repoRoot } from './helpers/ts-imports';
import { cleanupFixtures, copyFixture } from './fixtures/seed';
import { buildLegacyFixture, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
// Type-only: migrate-child is an entry point that runs on import, so this file must never load it.
import type { KillPoint } from './fixtures/migrate-child';
import {
    captureInvariants,
    diffInvariants,
    originalColumns,
    predictAdoption
} from './helpers/db-invariants';

const CHILD_ENTRY = path.join(repoRoot, 'tests', 'fixtures', 'migrate-child.ts');
const NOW = new Date(2026, 5, 1, 9, 0, 0);
const MARKER_DEADLINE_MS = 45_000;

// Restated here rather than imported, because importing the child would execute it in this process.
const KILL_POINTS: readonly KillPoint[] = ['baseline-tx', 'between-v1-v2', 'v2-tx', 'backup'];

// A cut transaction must never be reported as applied: v1 commits before v2, and the backup precedes both.
const EXPECTED_VERSION: Readonly<Record<KillPoint, number>> = {
    'baseline-tx': 0,
    'between-v1-v2': 1,
    'v2-tx': 1,
    backup: 0
};

const tempDirs: string[] = [];
let bundlePath = '';

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-kill-' + tag + '-'));
    tempDirs.push(dir);
    return dir;
}

// The child is TypeScript importing an alias and a ?raw SQL file, so Node cannot run it directly.
beforeAll(async () => {
    const outDir = tempDir('bundle');
    await build({
        configFile: false,
        logLevel: 'silent',
        resolve: {
            alias: {
                '@main': path.join(repoRoot, 'src', 'main'),
                '@lib': path.join(repoRoot, 'src', 'lib'),
                '@shared': path.join(repoRoot, 'src', 'shared')
            }
        },
        build: {
            ssr: CHILD_ENTRY,
            outDir,
            emptyOutDir: true,
            rollupOptions: {
                external: ['better-sqlite3', /^node:/],
                output: { format: 'cjs', entryFileNames: 'child.cjs' }
            }
        }
    });
    bundlePath = path.join(outDir, 'child.cjs');
    expect(fs.existsSync(bundlePath), 'the child bundle was not written').toBe(true);
}, 180_000);

afterAll(() => {
    cleanupFixtures();
    cleanupLegacyFixtures();
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const backupsIn = (dir: string): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.bak')).sort() : [];

// Reopening read-write is what the next launch does, and it recovers the -wal the kill left behind.
function reopenAndCheckIntegrity(dbPath: string): unknown {
    const db = openDatabase(dbPath);
    try {
        return db.pragma('integrity_check', { simple: true });
    } finally {
        closeDatabase(db);
    }
}

const userVersionOf = (dbPath: string): unknown => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return db.pragma('user_version', { simple: true });
    } finally {
        db.close();
    }
};

async function migrateReal(dbPath: string, backupDir: string): Promise<MigrationReport> {
    const probe = probeDatabase(dbPath);
    if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
    const db = openDatabase(dbPath);
    try {
        return await migrateDatabase(db, {
            dbPath,
            dbClass: classify(probe.observed, LATEST),
            fromVersion: probe.observed.userVersion,
            backupDir,
            now: NOW
        });
    } finally {
        closeDatabase(db);
    }
}

// Forks the bundled child, waits for its marker, and SIGKILLs it exactly there.
function killAt(dbPath: string, backupDir: string, point: KillPoint): Promise<void> {
    const markerPath = path.join(path.dirname(dbPath), 'marker-' + point);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    env.NODE_PATH = path.join(repoRoot, 'node_modules');

    return new Promise<void>((resolve, reject) => {
        const child = fork(bundlePath, [dbPath, backupDir, point, markerPath], {
            env,
            stdio: ['ignore', 'ignore', 'inherit', 'ipc']
        });
        let killed = false;
        let settled = false;
        const deadline = Date.now() + MARKER_DEADLINE_MS;

        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            if (error === undefined) resolve();
            else reject(error);
        };

        const poll = setInterval(() => {
            if (killed) return;
            if (fs.existsSync(markerPath)) {
                killed = true;
                child.kill('SIGKILL');
                return;
            }
            if (Date.now() > deadline) {
                killed = true;
                child.kill('SIGKILL');
                finish(new Error('migrate-child never reached the ' + point + ' kill point'));
            }
        }, 25);

        child.on('error', (error) => { finish(error); });
        child.on('exit', (code, signal) => {
            if (!killed) {
                finish(new Error('migrate-child exited before signalling ' + point +
                    ' (code ' + String(code) + ', signal ' + String(signal) + ')'));
                return;
            }
            finish();
        });
    });
}

describe('D-24: a SIGKILL mid-migration leaves a recoverable database', () => {
    it.each(KILL_POINTS)(
        'a kill at %s reopens intact, reports no cut version, and a re-run finishes the job',
        async (point) => {
            // The 'big' variant exceeds PAGES_PER_STEP, so the backup kill lands mid-copy.
            const fixture = copyFixture(buildLegacyFixture('C', 'big'));
            const backupDir = path.join(path.dirname(fixture), 'backups');
            const before = captureInvariants(fixture);
            expect(before.counts.work_sessions, 'the kill fixture must be large enough to copy in steps')
                .toBe(2500);

            await killAt(fixture, backupDir, point);

            expect(reopenAndCheckIntegrity(fixture), point + ': integrity_check after the kill').toBe('ok');

            const version = userVersionOf(fixture);
            expect(version, point + ': a cut transaction must never be reported as applied')
                .toBe(EXPECTED_VERSION[point]);

            const over = originalColumns(before);
            const after = captureInvariants(fixture, { over });
            // D-13 predicts no change for this fixture (Unassigned exists, no NULL company_id, all 13 settings),
            // so at either version the claim is that the killed run altered nothing.
            const expected = version === 0 ? before : predictAdoption(before);
            expect(diffInvariants(expected, after), point + ': D-23 invariants after the kill').toEqual([]);
            expect(after.totalDuration, point + ': tracked time after the kill').toBe(before.totalDuration);

            const partials = backupsIn(backupDir);
            if (point === 'backup') {
                // CR-02: the copy is written under a staging name and moved onto the retention-counted one only
                // after it verifies, so a killed backup can leave nothing retention will count or trust.
                const staged = fs.readdirSync(backupDir).filter((name) => name.endsWith(PENDING_SUFFIX));
                expect(staged.length, 'the kill landed before the copy began, so this proves nothing')
                    .toBeGreaterThan(0);
                expect(partials, 'a killed backup left a retention-counted .bak behind').toEqual([]);
            }

            const report = await migrateReal(fixture, backupDir);
            expect(report.toVersion, point + ': the re-run reaches LATEST').toBe(LATEST);
            expect(userVersionOf(fixture)).toBe(LATEST);

            if (point === 'backup') {
                expect(report.backupPath, 'the re-run takes its own backup').not.toBeNull();
                const taken = report.backupPath ?? '';
                expect(backupsIn(backupDir), 'the only .bak is the one the re-run verified')
                    .toEqual([path.basename(taken)]);
                expect(verifyBackup(taken).integrity, 'the re-run backup verifies').toBe('ok');
                expect(fs.readdirSync(backupDir).filter((name) => name.endsWith(PENDING_SUFFIX)),
                    'the killed run\'s staging file outlived the next backup').toEqual([]);
            }

            const final = captureInvariants(fixture, { over });
            expect(diffInvariants(predictAdoption(before), final), point + ': D-23 invariants after the re-run')
                .toEqual([]);
        },
        60_000
    );
});

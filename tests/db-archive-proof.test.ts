// D-28: migrate a temp COPY of the owner's archived real database and assert the D-23 invariants. Aggregates only -
// never a row value, a company name or a note (T-01-37). The proof runs only behind the D-01 door; its guards always run.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase } from '../src/lib/db/runner';
import { LATEST } from '../src/lib/db/migrations/registry';
import {
    captureInvariants,
    diffInvariants,
    originalColumns,
    predictAdoption
} from './helpers/db-invariants';

export const APPROVAL_ENV = 'WORKFLOW_ARCHIVE_PROOF';
export const APPROVAL_TOKEN = 'approved-archive';

const DATABASE_FILE = 'krono.db';
const SIDECARS = ['krono.db-wal', 'krono.db-shm'];
const ARCHIVE_DIR = 'workflow-timer-archive';
const DATED = /^\d{4}-\d{2}-\d{2}$/;
const NOW = new Date(2026, 8, 12, 12, 0, 0);

/** The single gate. A bare `1` is not enough: only the owner's recorded choice reaches this value (D-01). */
export function archiveProofApproved(env: NodeJS.ProcessEnv): boolean {
    return env[APPROVAL_ENV] === APPROVAL_TOKEN;
}

interface RealPaths {
    readonly archiveRoot: string;
    readonly liveDir: string;
    readonly liveDb: string;
}

/** Pure: both locations are computed from the environment, and nothing here opens, stats or lists them. */
export function realPaths(env: NodeJS.ProcessEnv, home: string): RealPaths {
    const liveDir = env.WFT_REAL_USERDATA ??
        path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'workflow-timer');
    return { archiveRoot: path.join(home, ARCHIVE_DIR), liveDir, liveDb: path.join(liveDir, DATABASE_FILE) };
}

interface WriteTargets {
    readonly copy: string;
    readonly backupDir: string;
    readonly sidecars: readonly string[];
}

/** Pure: every path the proof writes to, so a test can prove all of them sit inside the mkdtemp root. */
export function writeTargets(tempRoot: string): WriteTargets {
    return {
        copy: path.join(tempRoot, DATABASE_FILE),
        backupDir: path.join(tempRoot, 'backups'),
        sidecars: SIDECARS.map((name) => path.join(tempRoot, name))
    };
}

interface ArchiveDeps {
    readonly hashFile: (file: string) => string | null;
    readonly copyFile: (from: string, to: string) => void;
    readonly listDir: (dir: string) => readonly string[];
    readonly openDatabase: (dbPath: string) => Database.Database;
    readonly log: (line: string) => void;
}

interface ArchiveOutcome {
    readonly ok: true;
    readonly archivedAt: string;
    readonly counts: Readonly<Record<string, number | null>>;
    readonly totalDuration: number | null;
}

type ArchiveResult = 'refused' | ArchiveOutcome;

/**
 * D-28, in order: re-verify the archive against the live file (a hash of bytes, never a SQLite open),
 * copy it as bytes into a temp directory, run the full chain on the copy, assert the D-23 invariants,
 * delete the copy, and re-hash both real files. Output is counts, sums, digests and pass/fail only.
 */
export async function runArchiveProof(env: NodeJS.ProcessEnv, deps: ArchiveDeps): Promise<ArchiveResult> {
    if (!archiveProofApproved(env)) return 'refused';

    const { log } = deps;
    const { archiveRoot, liveDb } = realPaths(env, os.homedir());

    const dated = [...deps.listDir(archiveRoot)].filter((name) => DATED.test(name)).sort().reverse();
    const archivedAt = dated.find((name) => deps.listDir(path.join(archiveRoot, name)).includes(DATABASE_FILE));
    if (archivedAt === undefined) throw new Error('no dated archive directory holds a ' + DATABASE_FILE);
    const archiveDir = path.join(archiveRoot, archivedAt);
    const archiveDb = path.join(archiveDir, DATABASE_FILE);

    const archiveBefore = deps.hashFile(archiveDb);
    const liveBefore = deps.hashFile(liveDb);
    log('LIVE_HASH_BEFORE=' + (liveBefore ?? 'absent'));
    log('ARCHIVE_DATE=' + archivedAt);
    if (archiveBefore === null) throw new Error('the archived ' + DATABASE_FILE + ' is missing');
    if (archiveBefore !== liveBefore) {
        throw new Error('the archive no longer matches the live database; refusing to migrate a stale copy (D-02)');
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-archive-proof-'));
    let outcome: ArchiveOutcome;
    try {
        const targets = writeTargets(tempRoot);
        deps.copyFile(archiveDb, targets.copy);
        const present = deps.listDir(archiveDir);
        for (const [index, name] of SIDECARS.entries()) {
            if (present.includes(name)) deps.copyFile(path.join(archiveDir, name), targets.sidecars[index] as string);
        }
        if (deps.hashFile(targets.copy) !== archiveBefore) throw new Error('the temp copy is not byte-identical');

        const before = captureInvariants(targets.copy);
        log('BEFORE counts=' + JSON.stringify(before.counts) + ' sum(duration)=' + String(before.totalDuration));
        log('BEFORE digests=' + JSON.stringify(
            Object.fromEntries(Object.entries(before.tables).map(([t, v]) => [t, v?.digest.slice(0, 16) ?? null]))
        ));

        const probe = probeDatabase(targets.copy);
        if (!probe.ok) throw new Error('probe failed: ' + probe.reason);
        const db = deps.openDatabase(targets.copy);
        let report;
        try {
            report = await migrateDatabase(db, {
                dbPath: targets.copy,
                dbClass: classify(probe.observed, LATEST),
                fromVersion: probe.observed.userVersion,
                backupDir: targets.backupDir,
                now: NOW
            });
        } finally {
            closeDatabase(db);
        }
        log('CHAIN class=' + report.dbClass + ' applied=' + JSON.stringify(report.applied) +
            ' toVersion=' + String(report.toVersion) + ' backup=' + (report.backupPath === null ? 'none' : 'taken'));

        const after = captureInvariants(targets.copy, { over: originalColumns(before) });
        // The diff lines carry cell values, so only their COUNT is ever reported (T-04-52).
        const differences = diffInvariants(predictAdoption(before), after);
        log('INVARIANT_DIFFERENCES=' + String(differences.length));
        if (differences.length > 0) {
            throw new Error(String(differences.length) + ' invariant differences the D-13 adoption does not predict');
        }
        log('AFTER counts=' + JSON.stringify(after.counts) + ' sum(duration)=' + String(after.totalDuration));
        log('AFTER digests=' + JSON.stringify(
            Object.fromEntries(Object.entries(after.tables).map(([t, v]) => [t, v?.digest.slice(0, 16) ?? null]))
        ));
        if (after.totalDuration !== before.totalDuration) throw new Error('sum(duration) changed');
        if (report.toVersion !== LATEST) throw new Error('the copy did not reach LATEST');

        outcome = { ok: true, archivedAt, counts: after.counts, totalDuration: after.totalDuration };
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    if (fs.existsSync(tempRoot)) throw new Error('the temp copy was not deleted');

    const liveAfter = deps.hashFile(liveDb);
    if (deps.hashFile(archiveDb) !== archiveBefore) throw new Error('the archived database changed during the proof');
    log('LIVE_HASH_AFTER=' + (liveAfter ?? 'absent'));
    if (liveAfter !== liveBefore) throw new Error('the live database changed during the proof');

    log('REAL_DATA_PROOF_PASS archive');
    return outcome;
}

/* ---------------------------------------------------------------------------------------- */
/* The real dependencies - referenced here, invoked only inside the gated test                */
/* ---------------------------------------------------------------------------------------- */

const REAL_DEPS: ArchiveDeps = {
    hashFile: (file) =>
        fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null,
    // Bytes, not fs.copyFile: the source is a database file and CUSTODY-03 keeps that API off it entirely.
    copyFile: (from, to) => fs.writeFileSync(to, fs.readFileSync(from)),
    listDir: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
    openDatabase,
    log: (line) => console.log(line)
};

/* ---------------------------------------------------------------------------------------- */
/* Always-run guards                                                                          */
/* ---------------------------------------------------------------------------------------- */

interface Recorder {
    readonly calls: string[];
    readonly lines: string[];
}

const recorder = (): Recorder => ({ calls: [], lines: [] });

const forbiddenDeps = (rec: Recorder): ArchiveDeps => ({
    hashFile: (): never => { rec.calls.push('hashFile'); throw new Error('hashFile must never be called'); },
    copyFile: (): never => { rec.calls.push('copyFile'); throw new Error('copyFile must never be called'); },
    listDir: (): never => { rec.calls.push('listDir'); throw new Error('listDir must never be called'); },
    openDatabase: (): never => { rec.calls.push('openDatabase'); throw new Error('openDatabase must never be called'); },
    log: (line) => rec.lines.push(line)
});

describe('D-01: the archive proof is gated on one exact token', () => {
    const REJECTED = ['', '1', 'true', 'approved', 'APPROVED-ARCHIVE', ' approved-archive', 'approved-archive '];

    it('is false when the variable is absent', () => {
        expect(archiveProofApproved({})).toBe(false);
    });

    it.each(REJECTED)('is false for %j', (value) => {
        expect(archiveProofApproved({ [APPROVAL_ENV]: value })).toBe(false);
    });

    it('is true only for the exact token', () => {
        expect(archiveProofApproved({ [APPROVAL_ENV]: APPROVAL_TOKEN })).toBe(true);
    });
});

describe('D-02: the proof computes its real paths without touching them', () => {
    it('derives the live database from WFT_REAL_USERDATA when it is set', () => {
        const paths = realPaths({ WFT_REAL_USERDATA: path.join('X:', 'box') }, path.join('X:', 'home'));
        expect(paths.liveDb).toBe(path.join('X:', 'box', DATABASE_FILE));
        expect(paths.archiveRoot).toBe(path.join('X:', 'home', ARCHIVE_DIR));
    });

    it('falls back to APPDATA, then to the home directory', () => {
        expect(realPaths({ APPDATA: path.join('X:', 'roaming') }, path.join('X:', 'home')).liveDb)
            .toBe(path.join('X:', 'roaming', 'workflow-timer', DATABASE_FILE));
        expect(realPaths({}, path.join('X:', 'home')).liveDb)
            .toBe(path.join('X:', 'home', 'AppData', 'Roaming', 'workflow-timer', DATABASE_FILE));
    });

    it('writes only inside the mkdtemp root', () => {
        const root = path.join(os.tmpdir(), 'wft-archive-proof-targets');
        const targets = writeTargets(root);
        for (const target of [targets.copy, targets.backupDir, ...targets.sidecars]) {
            expect(path.relative(root, target).startsWith('..'), target).toBe(false);
            expect(path.isAbsolute(path.relative(root, target)), target).toBe(false);
        }
    });
});

describe('the archive proof refuses without owner approval', () => {
    const REFUSED: (string | undefined)[] = [undefined, '', '1', 'true', 'approved', 'APPROVED-ARCHIVE'];

    it.each(REFUSED.map((value) => [JSON.stringify(value ?? null), value] as const))(
        'refuses without owner approval: %s reads, hashes and copies nothing',
        async (_label, value) => {
            const rec = recorder();
            const env: NodeJS.ProcessEnv = value === undefined ? {} : { [APPROVAL_ENV]: value };
            const result = await runArchiveProof(env, forbiddenDeps(rec));

            expect(result).toBe('refused');
            expect(rec.calls).toEqual([]);
            expect(rec.lines).toEqual([]);
        }
    );
});

/* ---------------------------------------------------------------------------------------- */
/* The proof itself (D-28) - skipped, never failed, without the owner's token                 */
/* ---------------------------------------------------------------------------------------- */

describe.skipIf(!archiveProofApproved(process.env))(
    'D-28 archive proof (skipped: runs only behind the D-01 checkpoint with ' +
    APPROVAL_ENV + '=' + APPROVAL_TOKEN + ')',
    () => {
        it('migrates a temp copy of the archived real database with its invariants intact', async () => {
            const result = await runArchiveProof(process.env, REAL_DEPS);
            expect(result).not.toBe('refused');
            if (result === 'refused') return;
            expect(result.ok).toBe(true);
            expect(result.counts.work_sessions).toBeGreaterThan(0);
            expect(result.totalDuration).toBeGreaterThan(0);
        }, 300_000);
    }
);

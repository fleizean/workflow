// D-21: judges uncommitted candidate migration files through the real runner over the whole corpus.
// Enabled only by WORKFLOW_MIGRATION_CANDIDATE=1; it prints schema text, hashes, object names and counts only.

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { classify } from '../src/lib/db/classify';
import { closeDatabase, openDatabase } from '../src/lib/db/client';
import { probeDatabase } from '../src/lib/db/probe';
import { migrateDatabase, splitStatements } from '../src/lib/db/runner';
import type { MigrationStep } from '../src/lib/db/runner';
import { cleanupFixtures, copyFixture, schemaOf } from './fixtures/seed';
import { LEGACY_CORPUS, cleanupLegacyFixtures } from './fixtures/legacy-shapes';
import { executeV121Init, runV121Downgrade } from './helpers/v121-sql';
import {
    V121_TABLES,
    checkAllowedDelta,
    checkMigrationSql,
    checkRuntimeTrace,
    snapshotSchema
} from './helpers/additive-guard';
import type { GuardContext } from './helpers/additive-guard';

// A fixed directory, so no path has to travel through a Git Bash environment variable.
const CANDIDATE_ROOT = path.join(os.tmpdir(), 'wft-migration-candidate');
const MIGRATIONS_DIR = path.join(CANDIDATE_ROOT, 'migrations');
const enabled = process.env.WORKFLOW_MIGRATION_CANDIDATE === '1';

const TITLE = enabled
    ? 'D-21 candidate evidence'
    : 'D-21 candidate evidence (skipped: set WORKFLOW_MIGRATION_CANDIDATE=1 after generating into ' +
        MIGRATIONS_DIR + ')';

const TODAY = '2026-01-05';

const ctx: GuardContext = {
    v121Tables: V121_TABLES,
    milestoneTables: [],
    existingTables: [...V121_TABLES, 'sqlite_sequence']
};

interface Journal {
    entries: { idx: number; tag: string }[];
}

interface CandidateFile {
    readonly tag: string;
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly step: MigrationStep;
}

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-candidate-' + tag + '-'));
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

// Entry 0 is the v1.2.1 baseline: it maps to version 1 and is never applied (Pattern 1, Pitfall 3).
function loadCandidate(): CandidateFile[] {
    const journalPath = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal;
    return [...journal.entries]
        .sort((a, b) => a.idx - b.idx)
        .map((entry): CandidateFile => {
            const file = path.join(MIGRATIONS_DIR, entry.tag + '.sql');
            const bytes = fs.readFileSync(file);
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const step: MigrationStep = entry.idx === 0
                ? { version: 1, tag: entry.tag, kind: 'baseline' }
                : { version: entry.idx + 1, tag: entry.tag, kind: 'sql', sql: bytes.toString('utf8') };
            return { tag: entry.tag, file, sha256, bytes: bytes.length, step };
        });
}

function objectNames(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db.prepare<[], { name: string }>('SELECT name FROM sqlite_master ORDER BY name')
            .all().map((row) => row.name);
    } finally {
        db.close();
    }
}

function rowCounts(dbPath: string): string {
    const db = new Database(dbPath, { readonly: true });
    try {
        const present = new Set(
            db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all().map((row) => row.name)
        );
        return V121_TABLES.map((table) => {
            if (!present.has(table)) return table + '=absent';
            // `table` is one of V121_TABLES, a module constant, never caller input (T-01-35).
            const row = db.prepare<[], { c: number }>('SELECT count(*) AS c FROM "' + table + '"').get();
            return table + '=' + String(row?.c ?? 0);
        }).join(' ');
    } finally {
        db.close();
    }
}

describe.skipIf(!enabled)(TITLE, () => {
    it('reports every candidate file and migrates the whole corpus through the real runner', async () => {
        const report: string[] = [];
        const say = (line: string): void => { report.push(line); };
        const violations: string[] = [];

        const candidates = loadCandidate();
        const steps = candidates.map((candidate) => candidate.step);
        const latest = steps.length;

        say('');
        say('=== D-21 CANDIDATE EVIDENCE ===');
        say('directory: ' + MIGRATIONS_DIR);
        say('steps: ' + String(latest) + ' (v1 = baseline, never applied)');
        say('');

        for (const candidate of candidates) {
            say(candidate.tag);
            say('  sha256 ' + candidate.sha256);
            say('  bytes  ' + String(candidate.bytes));
            if (candidate.step.kind === 'baseline') {
                say('  baseline entry: mapped to v1 and never applied');
                continue;
            }
            const result = checkMigrationSql(candidate.step.sql, ctx);
            say('  creates: ' + (result.created.length === 0 ? '(nothing)' : result.created.join(', ')));
            say('  statements: ' + String(result.statements.length));
            say('  static guard: ' + (result.ok ? 'OK' : 'VIOLATIONS'));
            for (const violation of result.violations) {
                say('    ! ' + violation.statement + ' - ' + violation.rule);
                violations.push(candidate.tag + ' static: ' + violation.rule);
            }
        }

        const candidateSql = candidates
            .filter((candidate) => candidate.step.kind === 'sql')
            .map((candidate) => (candidate.step.kind === 'sql' ? candidate.step.sql : ''));

        // Subject 0 is a fresh install; the rest is the whole legacy corpus, each on a copy.
        const subjects: { id: string; dbPath: string }[] = [
            { id: 'fresh', dbPath: path.join(tempDir('fresh'), 'krono.db') }
        ];
        for (const entry of LEGACY_CORPUS) {
            subjects.push({ id: entry.id, dbPath: copyFixture(await entry.build()) });
        }

        say('');
        say('--- corpus (' + String(subjects.length) + ' subjects) ---');

        for (const subject of subjects) {
            const probe = probeDatabase(subject.dbPath);
            if (!probe.ok) {
                violations.push(subject.id + ': probe failed - ' + probe.reason);
                say(subject.id + ': PROBE FAILED');
                continue;
            }
            const dbClass = classify(probe.observed, latest);
            const trace: string[] = [];
            const backupDir = tempDir('backups');

            // Taken BEFORE this subject is migrated, so the delta check below runs against a v1 database.
            const deltaPath = copyFixture(subject.dbPath);

            const db = openDatabase(subject.dbPath, { verbose: (statement) => { trace.push(String(statement)); } });
            let applied: number[] = [];
            try {
                const result = await migrateDatabase(db, {
                    dbPath: subject.dbPath,
                    dbClass,
                    fromVersion: probe.observed.userVersion,
                    backupDir,
                    steps,
                    applyBaseline: executeV121Init
                });
                applied = result.applied;
            } finally {
                closeDatabase(db);
            }

            const traceViolations = checkRuntimeTrace(trace, ctx);
            for (const violation of traceViolations) {
                violations.push(subject.id + ' trace: ' + violation);
            }

            // Each candidate statement alone, on the copy taken before this subject was migrated.
            const deltaViolations: string[] = [];
            const deltaDb = openDatabase(deltaPath);
            try {
                executeV121Init(deltaDb);
                for (const sql of candidateSql) {
                    for (const chunk of splitStatements(sql)) {
                        const before = snapshotSchema(deltaDb);
                        try {
                            deltaDb.prepare(chunk).run();
                        } catch (error) {
                            deltaViolations.push(
                                'a candidate statement did not execute on a v1 database: ' +
                                (error instanceof Error ? error.message : String(error))
                            );
                            continue;
                        }
                        const after = snapshotSchema(deltaDb);
                        for (const violation of checkAllowedDelta(before, after, ctx)) {
                            deltaViolations.push(violation.rule + ' (' + violation.object + ')');
                        }
                    }
                }
            } finally {
                closeDatabase(deltaDb);
            }
            for (const violation of deltaViolations) {
                violations.push(subject.id + ' delta: ' + violation);
            }

            // Counted BEFORE the downgrade probe, which writes a session of its own: these are the
            // migration's numbers, not the probe's.
            const names = objectNames(subject.dbPath);
            const rows = rowCounts(subject.dbPath);

            // D-26: v1.2.1's own SQL against the migrated database.
            const downgradeDb = openDatabase(subject.dbPath);
            let downgrade;
            try {
                downgrade = runV121Downgrade(downgradeDb, TODAY);
            } finally {
                closeDatabase(downgradeDb);
            }
            for (const failure of downgrade.failures) {
                violations.push(subject.id + ' downgrade: ' + failure);
            }

            say(
                subject.id.padEnd(20) +
                ' class=' + dbClass.padEnd(14) +
                ' applied=[' + applied.join(',') + ']' +
                ' objects=' + String(names.length) +
                ' trace=' + (traceViolations.length === 0 ? 'OK' : 'BAD') +
                ' delta=' + (deltaViolations.length === 0 ? 'OK' : 'BAD') +
                ' downgrade=' + (downgrade.ok ? 'OK' : 'BAD')
            );
            say('    rows ' + rows);
        }

        const fresh = subjects[0];
        if (fresh !== undefined) {
            say('');
            say('--- fresh install schema after the candidate ---');
            say(schemaOf(fresh.dbPath));
        }

        say('');
        say('violations: ' + String(violations.length));
        say('=== END D-21 CANDIDATE EVIDENCE ===');

        // The harness exists to hand this report to the owner (D-21). It is written beside the candidate
        // files as well as printed, because a test runner may capture stdout.
        const reportText = report.join('\n');
        const reportPath = path.join(CANDIDATE_ROOT, 'd21-report.txt');
        fs.writeFileSync(reportPath, reportText);
        console.log(reportText);
        console.log('report written to ' + reportPath);

        expect(violations).toEqual([]);
    }, 900_000);
});

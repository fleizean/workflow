import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/*
 * Why this file exists, and why it duplicates a CI step.
 *
 * This repository is public. %APPDATA%\workflow-timer\krono.db holds real client names and real
 * work notes. Committing it is the one mistake in this whole restructure that cannot be undone:
 * a history rewrite does not reach the clones already taken, and there is no server and no
 * telemetry through which anything could be recalled. D-03 therefore says schema only, and this
 * file is what turns that decision from a thing someone remembers into a thing the suite checks.
 *
 * Plan 01-02 added an equivalent step to .github/workflows/verify.yml. The duplication is
 * deliberate: the CI step catches the mistake before a push reaches the remote, this test catches
 * it in the local loop before the commit exists at all. For an irreversible mistake, two
 * independent checks at two different moments is the right amount, not redundancy.
 *
 * The same reasoning covers the installer binaries. They are 83.5 MB and 106 MB, .gitignore does
 * not exclude *.exe or *.dmg, and 190 MB of blobs in a public git history is equally permanent.
 * They are pinned by digest in baselines/v1.2.1/MANIFEST.md instead (CUSTODY-08).
 *
 * Failure messages name the offending paths on purpose. A bare boolean failure here would tell
 * the reader nothing about what to remove, and the removal is urgent.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCHEMA_EXTRACT = 'tests/fixtures/v121-real-schema.sql';
const MANIFEST = 'baselines/v1.2.1/MANIFEST.md';
const FETCH_SCRIPT = 'tools/baseline/fetch-installer.sh';

const V121_TABLES = ['companies', 'work_sessions', 'settings', 'pomodoro_sessions'];

const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/*
 * git, not a filesystem walk. The question is not "is there a database on this disk" - there
 * always is, that is the point of the archive - but "is one TRACKED", which only git can answer.
 * execFileSync with an argument array rather than a shell string: no shell, no quoting surface.
 */
const trackedFiles = (): string[] =>
    execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

const trackedMatching = (extensions: string[]): string[] =>
    trackedFiles().filter((file) => extensions.some((ext) => file.toLowerCase().endsWith(ext)));

/*
 * Every unbroken run of 32 or more hex characters in the manifest is a digest candidate. A
 * correctly pasted SHA-256 is exactly 64; a truncated one is shorter; one wrapped across two
 * lines by an editor becomes two shorter runs. All three failure shapes surface here, at commit
 * time, rather than at the moment someone tries to verify an 87 MB download against it.
 */
const digestCandidates = (text: string): string[] => text.match(/\b[0-9a-fA-F]{32,}\b/g) ?? [];

describe('CUSTODY-07 / CUSTODY-08: no real user data and no large binary enters this repository', () => {
    it('tracks no database file - .db, .db-wal or .db-shm (D-03)', () => {
        const offenders = trackedMatching(['.db', '.db-wal', '.db-shm']);
        expect(
            offenders,
            'Database files are TRACKED BY GIT:\n  ' + offenders.join('\n  ') +
            '\nRemove with: git rm --cached <file>\n' +
            'A database pushed to this public repository cannot be un-published - clones taken ' +
            'before any history rewrite keep the user\'s real client names and work notes (D-03).'
        ).toEqual([]);
    });

    it('tracks no installer binary - .exe or .dmg (CUSTODY-08)', () => {
        const offenders = trackedMatching(['.exe', '.dmg']);
        expect(
            offenders,
            'Installer binaries are TRACKED BY GIT:\n  ' + offenders.join('\n  ') +
            '\nRemove with: git rm --cached <file>\n' +
            'The v1.2.1 installers are 83.5 MB and 106 MB and are pinned by SHA-256 in ' +
            MANIFEST + ' instead. Fetch them with tools/baseline/fetch-installer.sh.'
        ).toEqual([]);
    });

    it('.gitignore still excludes *.db, *.db-shm and *.db-wal', () => {
        const lines = read('.gitignore')
            .split('\n')
            .map((line) => line.replace(/\r$/, '').trim());
        const required = ['*.db', '*.db-shm', '*.db-wal'];
        const missing = required.filter((pattern) => !lines.includes(pattern));
        expect(
            missing,
            'These .gitignore patterns have been removed: ' + missing.join(', ') +
            '\nThey are the first of three layers stopping a real krono.db from being committed ' +
            '(the others are this test and the verify workflow). Restore them.'
        ).toEqual([]);
    });

    it('the committed v1.2.1 schema extract exists and declares all four tables', () => {
        const extractPath = path.join(repoRoot, SCHEMA_EXTRACT);
        expect(
            fs.existsSync(extractPath),
            SCHEMA_EXTRACT + ' is missing. Regenerate it with: ' +
            'node tools/baseline/archive-real-db.mjs'
        ).toBe(true);

        const sql = read(SCHEMA_EXTRACT);
        const missing = V121_TABLES.filter(
            (table) => !new RegExp('CREATE TABLE ' + table + '\\b').test(sql)
        );
        expect(
            missing,
            'The schema extract has no CREATE TABLE for: ' + missing.join(', ') +
            '\nD-05 makes this extract load-bearing: plan 01-07 diffs it against the DDL in ' +
            'database/db.js to decide whether a second legacy-variant fixture is needed.'
        ).toEqual([]);
    });

    it('the committed v1.2.1 schema extract carries no row data (D-03)', () => {
        const sql = read(SCHEMA_EXTRACT);

        expect(
            /\bINSERT\b/i.test(sql),
            SCHEMA_EXTRACT + ' contains an insert statement. This file is DDL ONLY. Any row in ' +
            'it is a real work session belonging to a real client, in a public repository.'
        ).toBe(false);

        expect(
            /\bVALUES\s*\(/i.test(sql),
            SCHEMA_EXTRACT + ' contains a VALUES clause. This file is DDL ONLY (D-03).'
        ).toBe(false);

        /*
         * DEFAULT '...' is the only legitimate string literal in a CREATE TABLE. Anything else
         * quoted is a value, and a value in this file is a client name or a work note.
         */
        const withoutComments = sql.replace(/^--.*$/gm, '');
        const withoutDefaults = withoutComments.replace(
            /DEFAULT\s+'(?:[^']|'')*'/gi,
            'DEFAULT <literal>'
        );
        const stray = withoutDefaults.match(/'(?:[^']|'')*'/g) ?? [];
        expect(
            stray,
            SCHEMA_EXTRACT + ' contains string literals that are not column defaults: ' +
            stray.slice(0, 5).join(', ') + '\nThese may be real user data (D-03).'
        ).toEqual([]);
    });

    it('the installer manifest pins at least two distinct SHA-256 digests', () => {
        const manifest = read(MANIFEST);
        const digests = manifest.match(/\b[0-9a-f]{64}\b/g) ?? [];
        const distinct = new Set(digests);
        expect(
            distinct.size,
            MANIFEST + ' must pin a digest for both the Windows .exe and the macOS .dmg. ' +
            'Found ' + distinct.size + ' distinct 64-character lowercase hex digests. ' +
            'Without them the binary Phase 10 / REL-04 upgrade-tests against is unverifiable.'
        ).toBeGreaterThanOrEqual(2);
    });

    it('every digest in the installer manifest is exactly 64 lowercase hex characters', () => {
        const manifest = read(MANIFEST);
        const malformed = digestCandidates(manifest).filter(
            (candidate) => !/^[0-9a-f]{64}$/.test(candidate)
        );
        expect(
            malformed,
            MANIFEST + ' contains hex runs that are not a well-formed SHA-256: ' +
            malformed.map((m) => m + ' (' + m.length + ' chars)').join(', ') +
            '\nA digest truncated or wrapped across two lines when pasted rejects the CORRECT ' +
            'binary, which is worse than no pin at all - it looks like tampering.'
        ).toEqual([]);
    });

    it('the fetch script enforces exactly the digests the manifest documents', () => {
        const manifestDigests = new Set(read(MANIFEST).match(/\b[0-9a-f]{64}\b/g) ?? []);
        const scriptDigests = new Set(read(FETCH_SCRIPT).match(/\b[0-9a-f]{64}\b/g) ?? []);

        const undocumented = [...scriptDigests].filter((d) => !manifestDigests.has(d));
        const unenforced = [...manifestDigests].filter((d) => !scriptDigests.has(d));

        expect(
            { undocumented, unenforced },
            'The manifest and the fetch script disagree about which binaries are pinned.\n' +
            '  in ' + FETCH_SCRIPT + ' but not in ' + MANIFEST + ': ' + undocumented.join(', ') +
            '\n  in ' + MANIFEST + ' but not in ' + FETCH_SCRIPT + ': ' + unenforced.join(', ') +
            '\nThe manifest is the record and the script is the enforcement; if they drift, the ' +
            'documented pin is not the one actually checked.'
        ).toEqual({ undocumented: [], unenforced: [] });
    });

    it('the pinned release URLs use the current repository name, not the redirect (T-01-16)', () => {
        for (const rel of [MANIFEST, FETCH_SCRIPT]) {
            expect(
                /workflow-timer\/releases/.test(read(rel)),
                rel + ' uses the stale fleizean/workflow-timer release path. That URL only works ' +
                'because GitHub still honours a 301; the repository is now fleizean/workflow. ' +
                '(package.json\'s name field is a separate matter and must stay workflow-timer - ' +
                'it determines where every user\'s database lives. See tests/app-identity.test.ts.)'
            ).toBe(false);
        }
    });
});

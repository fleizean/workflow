// D-01/D-02/D-35.3: the continuity tool's guards, its refusal, and its whole orchestration - over stand-ins only.
// Nothing here launches Electron, reads the live krono.db or touches ~/workflow-timer-archive.

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assertTempUserData,
    elapsedOf,
    parseManifestPins,
    parseProofArgs,
    runContinuityProof,
    verifyArchivedAppPins
} from '../tools/db/legacy-timer-proof.mjs';
import type { ImportObservation, VerifiedPin } from '../tools/db/legacy-timer-proof.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join('tools', 'db', 'legacy-timer-proof.mjs');
const ARCHIVE_ROOT = path.join(os.homedir(), 'workflow-timer-archive');
const SMOKE_SEED_ENV = 'WORKFLOW_SMOKE_SEED_TIMER_STATE';

const tempRoots: string[] = [];

function sandbox(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-proof-' + tag + '-'));
    tempRoots.push(dir);
    return dir;
}

afterAll(() => {
    for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------------------------- */
/* The pins                                                                                   */
/* ---------------------------------------------------------------------------------------- */

const EXE_BYTES = Buffer.from('synthetic Workflow.exe bytes');
const ASAR_BYTES = Buffer.from('synthetic app.asar bytes');

const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const manifestText = (exeSha: string, asarSha: string, exeBytes = EXE_BYTES.length): string => [
    '| Extracted file | Bytes | SHA-256 |',
    '|---|---|---|',
    '| `Workflow.exe` | ' + exeBytes.toLocaleString('en-US') + ' | `' + exeSha + '` |',
    '| `resources/app.asar` | ' + String(ASAR_BYTES.length) + ' | `' + asarSha + '` |'
].join('\n');

const readSynthetic = (file: string): Buffer => (file === 'Workflow.exe' ? EXE_BYTES : ASAR_BYTES);

describe('D-35.3: the archived app is hash-pinned before it is ever launched', () => {
    const exeSha = digestOf(EXE_BYTES);
    const asarSha = digestOf(ASAR_BYTES);

    it('parses both pinned rows out of a manifest table', () => {
        const pins = parseManifestPins(manifestText(exeSha, asarSha));
        expect(pins['Workflow.exe']).toEqual({ bytes: EXE_BYTES.length, sha256: exeSha });
        expect(pins['resources/app.asar']).toEqual({ bytes: ASAR_BYTES.length, sha256: asarSha });
    });

    it('verifies both files when every byte matches', () => {
        const verified: VerifiedPin[] = verifyArchivedAppPins(manifestText(exeSha, asarSha), readSynthetic);
        expect(verified.map((pin) => pin.file)).toEqual(['Workflow.exe', 'resources/app.asar']);
    });

    it('throws naming Workflow.exe when its digest differs', () => {
        expect(() => verifyArchivedAppPins(manifestText('a'.repeat(64), asarSha), readSynthetic))
            .toThrow(/Workflow\.exe does not match its manifest pin/);
    });

    it('throws naming resources/app.asar when its digest differs', () => {
        expect(() => verifyArchivedAppPins(manifestText(exeSha, 'b'.repeat(64)), readSynthetic))
            .toThrow(/resources\/app\.asar does not match its manifest pin/);
    });

    it('throws when the recorded size differs, before any digest is trusted', () => {
        expect(() => verifyArchivedAppPins(manifestText(exeSha, asarSha, 999), readSynthetic))
            .toThrow(/Workflow\.exe is \d+ bytes; the manifest pins 999/);
    });

    it('throws when the manifest has no row for a pinned file', () => {
        expect(() => verifyArchivedAppPins('| `other.exe` | 1 | `' + 'c'.repeat(64) + '` |', readSynthetic))
            .toThrow(/Workflow\.exe has no SHA-256 pin/);
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The launch target                                                                          */
/* ---------------------------------------------------------------------------------------- */

describe('D-01/D-02: a launch target must be a temp directory outside the production userData', () => {
    it('accepts a freshly made temp directory', () => {
        const production = sandbox('prod-accept');
        const dir = path.join(sandbox('target'), 'ud');
        fs.mkdirSync(dir);
        expect(assertTempUserData(dir, production)).toBe(dir);
    });

    it('refuses a path that is not under the temp root', () => {
        const production = sandbox('prod-nontemp');
        expect(() => assertTempUserData(path.join(os.homedir(), 'wft-not-a-temp-dir'), production))
            .toThrow(/is not under /);
    });

    it('refuses a path inside the production userData directory', () => {
        const production = sandbox('prod-inside');
        const dir = path.join(production, 'ud');
        fs.mkdirSync(dir);
        expect(() => assertTempUserData(dir, production))
            .toThrow(/is inside the production userData directory/);
    });

    it('refuses the production userData directory itself', () => {
        const production = sandbox('prod-self');
        expect(() => assertTempUserData(production, production))
            .toThrow(/is inside the production userData directory/);
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The arguments                                                                              */
/* ---------------------------------------------------------------------------------------- */

describe('the CLI arguments are parsed, never guessed', () => {
    it('reads a mode, the hard-kill variant and the approval token verbatim', () => {
        expect(parseProofArgs(['--mode=v121', '--hard-kill', '--owner-approved=continuity']))
            .toEqual({ mode: 'v121', hardKill: true, ownerApproved: 'continuity' });
    });

    it('keeps a non-matching approval value verbatim rather than normalizing it', () => {
        expect(parseProofArgs(['--mode=v121', '--owner-approved=Continuity']).ownerApproved).toBe('Continuity');
        expect(parseProofArgs(['--mode=v121', '--owner-approved=']).ownerApproved).toBe('');
    });

    it('defaults to no mode, no hard kill and no approval', () => {
        expect(parseProofArgs([])).toEqual({ mode: null, hardKill: false, ownerApproved: null });
        expect(parseProofArgs(['--mode=new-build']))
            .toEqual({ mode: 'new-build', hardKill: false, ownerApproved: null });
    });

    it('throws on an unknown mode and on an unrecognized argument', () => {
        expect(() => parseProofArgs(['--mode=production'])).toThrow(/unknown --mode=production/);
        expect(() => parseProofArgs(['--owner-aproved=continuity'])).toThrow(/unrecognized argument/);
    });

    it('floors the saved elapsed and reports whether v1.2.1 was running', () => {
        expect(elapsedOf('{"elapsed":7.9,"running":true}')).toEqual({ elapsedSeconds: 7, running: true });
        expect(elapsedOf('{"elapsed":0,"running":false}')).toEqual({ elapsedSeconds: 0, running: false });
        expect(() => elapsedOf('{"running":true}')).toThrow(/no numeric elapsed/);
    });
});

/* ---------------------------------------------------------------------------------------- */
/* Recording stand-ins                                                                        */
/* ---------------------------------------------------------------------------------------- */

interface Recorder {
    readonly paths: string[];
    readonly calls: string[];
    readonly lines: string[];
}

const recorder = (): Recorder => ({ paths: [], calls: [], lines: [] });

const forbidden = (rec: Recorder, name: string) => (): never => {
    rec.calls.push(name);
    throw new Error(name + ' must never be called here');
};

const isUnder = (parent: string, child: string): boolean => {
    const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

describe('mode new-build touches nothing real', () => {
    it('never resolves the archive, never hashes the live database and prints no LIVE_HASH line', async () => {
        const rec = recorder();
        const root = sandbox('dry');
        const production = path.join(root, 'production-userdata');
        fs.mkdirSync(production);
        const binary = path.join(root, 'Workflow.exe');
        let seededRaw: string | null = null;

        const result = await runContinuityProof(
            { mode: 'new-build', binary, productionDir: production, timeoutMs: 1000 },
            {
                resolveLaunch: forbidden(rec, 'resolveLaunch'),
                verifyPins: forbidden(rec, 'verifyPins'),
                launchElectron: forbidden(rec, 'launchElectron'),
                hashFile: (file: string) => {
                    rec.calls.push('hashFile');
                    rec.paths.push(file);
                    return 'f'.repeat(64);
                },
                readFile: forbidden(rec, 'readFile'),
                launchSmoke: (options) => {
                    rec.calls.push('launchSmoke');
                    rec.paths.push(options.binary, options.userDataDir);
                    const seed = options.env[SMOKE_SEED_ENV];
                    if (seed !== undefined) seededRaw = seed;
                    return Promise.resolve({ exit: { code: 0 } });
                },
                observeImport: (dbPath: string): ImportObservation => {
                    rec.paths.push(dbPath);
                    const raw = seededRaw ?? '';
                    return { stored: { raw, elapsedSeconds: elapsedOf(raw).elapsedSeconds }, workSessions: 0 };
                },
                log: (line: string) => rec.lines.push(line)
            }
        );

        expect(result.ok, rec.lines.join('\n')).toBe(true);
        expect(result.code).toBe(0);
        expect(rec.calls.filter((name) => name === 'resolveLaunch' || name === 'verifyPins')).toEqual([]);
        expect(rec.calls.filter((name) => name === 'hashFile')).toEqual([]);
        expect(rec.calls.filter((name) => name === 'launchElectron' || name === 'readFile')).toEqual([]);

        const liveDb = path.join(production, 'krono.db');
        for (const touched of rec.paths) {
            expect(isUnder(ARCHIVE_ROOT, touched), touched).toBe(false);
            expect(isUnder(production, touched), touched).toBe(false);
            expect(touched).not.toBe(liveDb);
            // Every krono.db the dry run names is the temp copy it just made.
            if (path.basename(touched) === 'krono.db') expect(isUnder(os.tmpdir(), touched), touched).toBe(true);
        }
        expect(rec.lines.filter((line) => line.startsWith('LIVE_HASH_'))).toEqual([]);
        expect(rec.lines.filter((line) => line.includes('REAL_DATA_PROOF_PASS'))).toEqual([]);
        expect(rec.lines).toContain('CONTINUITY_DRY_RUN_PASS');
        expect(rec.lines).toContain('RAW_EQUAL=true');
        expect(rec.lines).toContain('ELAPSED_EQUAL=true');
        expect(rec.lines).toContain('WORK_SESSIONS=0');
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The mode v121 output contract                                                              */
/* ---------------------------------------------------------------------------------------- */

const V121_RAW = JSON.stringify({ elapsed: 7, running: true, pomodoroMode: false, lastUpdated: 1_757_000_000_000 });

async function runApprovedV121(rec: Recorder, hashes: readonly string[]): Promise<{ ok: boolean; code: number }> {
    const root = sandbox('v121');
    const production = path.join(root, 'production-userdata');
    fs.mkdirSync(production);
    let hashCall = 0;

    return await runContinuityProof(
        {
            mode: 'v121',
            ownerApproved: 'continuity',
            binary: path.join(root, 'Workflow.exe'),
            productionDir: production,
            timeoutMs: 1000
        },
        {
            resolveLaunch: () => ({ executable: path.join(root, 'archived.exe'), args: ['--no-sandbox'] }),
            verifyPins: (): VerifiedPin[] => [{ file: 'Workflow.exe', bytes: 176_903_168, sha256: 'a'.repeat(64) }],
            launchElectron: () => {
                rec.calls.push('launchElectron');
                return Promise.resolve({ raw: V121_RAW });
            },
            launchSmoke: () => Promise.resolve({ exit: { code: 0 } }),
            hashFile: (file: string) => {
                rec.paths.push(file);
                const value = hashes[hashCall] ?? null;
                hashCall += 1;
                return value;
            },
            observeImport: (): ImportObservation => ({
                stored: { raw: V121_RAW, elapsedSeconds: 7 },
                workSessions: 0
            }),
            log: (line: string) => rec.lines.push(line)
        }
    );
}

describe('mode v121 reports the live database before and after, and passes only when the two agree', () => {
    it('prints both hashes and passes when they are equal', async () => {
        const rec = recorder();
        const hash = 'c'.repeat(64);
        const result = await runApprovedV121(rec, [hash, hash]);

        expect(result.ok, rec.lines.join('\n')).toBe(true);
        expect(rec.lines).toContain('LIVE_HASH_BEFORE=' + hash);
        expect(rec.lines).toContain('LIVE_HASH_AFTER=' + hash);
        expect(rec.lines).toContain('REAL_DATA_PROOF_PASS continuity');
        expect(rec.paths.every((file) => path.basename(file) === 'krono.db')).toBe(true);
    });

    it('prints both hashes and refuses to pass when they differ', async () => {
        const rec = recorder();
        const result = await runApprovedV121(rec, ['c'.repeat(64), 'd'.repeat(64)]);

        expect(result.ok).toBe(false);
        expect(result.code).not.toBe(0);
        expect(rec.lines).toContain('LIVE_HASH_BEFORE=' + 'c'.repeat(64));
        expect(rec.lines).toContain('LIVE_HASH_AFTER=' + 'd'.repeat(64));
        expect(rec.lines.filter((line) => line.includes('REAL_DATA_PROOF_PASS'))).toEqual([]);
    });

    it('reports an absent live database as absent, both times', async () => {
        const rec = recorder();
        const result = await runApprovedV121(rec, []);

        expect(result.ok, rec.lines.join('\n')).toBe(true);
        expect(rec.lines).toContain('LIVE_HASH_BEFORE=absent');
        expect(rec.lines).toContain('LIVE_HASH_AFTER=absent');
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The refusal (D-01)                                                                         */
/* ---------------------------------------------------------------------------------------- */

describe('mode v121 refuses without owner approval', () => {
    const REJECTED: (string | undefined)[] = [undefined, '', 'yes', '1', 'true', 'archive', 'Continuity', ' continuity'];

    it.each(REJECTED.map((token) => [JSON.stringify(token ?? null), token] as const))(
        'refuses without owner approval: %s calls no dependency and touches nothing',
        async (_label, token) => {
            const rec = recorder();
            const result = await runContinuityProof(
                { mode: 'v121', ownerApproved: token ?? null },
                {
                    resolveLaunch: forbidden(rec, 'resolveLaunch'),
                    verifyPins: forbidden(rec, 'verifyPins'),
                    launchElectron: forbidden(rec, 'launchElectron'),
                    launchSmoke: forbidden(rec, 'launchSmoke'),
                    hashFile: forbidden(rec, 'hashFile'),
                    readFile: forbidden(rec, 'readFile'),
                    observeImport: forbidden(rec, 'observeImport'),
                    log: (line: string) => rec.lines.push(line)
                }
            );

            expect(result.ok).toBe(false);
            expect(result.code).not.toBe(0);
            expect(result.refused).toBe(true);
            expect(rec.calls).toEqual([]);
            expect(rec.paths).toEqual([]);
            expect(rec.lines).toContain('REAL_DATA_PROOF_REFUSED continuity');
            expect(rec.lines.some((line) => line.includes('--owner-approved=continuity'))).toBe(true);
            expect(rec.lines.filter((line) => line.startsWith('LIVE_HASH_'))).toEqual([]);
            expect(rec.lines.filter((line) => line.includes('REAL_DATA_PROOF_PASS'))).toEqual([]);
        }
    );
});

interface SpawnResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/*
 * The CLI itself, in a sandbox every real-data path is redirected into: realUserDataDir() honours
 * WFT_REAL_USERDATA and resolveLaunch() honours WFT_V121_EXE, so even a broken gate could reach
 * only an empty temp directory. ELECTRON_RUN_AS_NODE and NODE_OPTIONS are removed, per D-02.
 */
function spawnRefused(args: readonly string[], box: string): SpawnResult {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    env.USERPROFILE = box;
    env.HOME = box;
    env.APPDATA = box;
    env.WFT_REAL_USERDATA = box;
    env.WFT_V121_EXE = path.join(box, 'Workflow.exe');

    try {
        const stdout = execFileSync(process.execPath, [TOOL, ...args], {
            cwd: repoRoot, env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe']
        });
        return { status: 0, stdout, stderr: '' };
    } catch (error) {
        const failure = error as { status?: number | null; stdout?: string; stderr?: string };
        return {
            status: failure.status ?? null,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? ''
        };
    }
}

describe('the spawned CLI refuses without owner approval', () => {
    const CASES: [string, string[]][] = [
        ['with no token at all', ['--mode=v121']],
        ['with the wrong token', ['--mode=v121', '--owner-approved=yes']],
        ['with the wrong token and --hard-kill', ['--mode=v121', '--hard-kill', '--owner-approved=1']]
    ];

    it.each(CASES)(
        'refuses without owner approval: %s',
        (_label, args) => {
            const box = sandbox('cli');
            const result = spawnRefused(args, box);

            expect(result.status, result.stdout + result.stderr).not.toBe(0);
            expect(result.stdout).toContain('REAL_DATA_PROOF_REFUSED continuity');
            expect(result.stdout).not.toContain('LIVE_HASH_');
            expect(result.stdout).not.toContain('REAL_DATA_PROOF_PASS');
            expect(fs.readdirSync(box), 'the sandbox must still be empty').toEqual([]);
        },
        30_000
    );
});

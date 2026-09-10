/*
 * tests/packaging.test.ts - BUILD-08, the checkable-on-every-push half of
 * tools/ci/assert-package-contents.mjs.
 *
 * The script's claim is about the artifact, not about the configuration that was supposed to
 * produce it: it enumerates the packaged app.asar from the archive's own header and checks every
 * path. That makes the header reader load-bearing. A reader that silently returned a partial
 * listing would report a clean package forever, so it is proven here against archives this file
 * encodes byte by byte from a known tree, with the expected listing written out longhand - the
 * real-fixtures-not-mocks convention tests/backup.test.ts established. Nothing below mocks the
 * reader or the filesystem: the on-disk cases write real packaged layouts, Windows and macOS, into
 * a temporary directory and inspect them, and the CLI cases run the script as a real process.
 *
 * None of this needs a packaged binary, which is the point of exporting the pure pieces: the
 * logic is checked on every push, and the packaging workflow runs the same script against the
 * real artifact on all four legs.
 *
 * The asar layout, specified from the format itself (no library, no new dependency):
 *
 *   bytes 0-3    uint32 LE = 4        the first pickle's payload size - it holds one uint32
 *   bytes 4-7    uint32 LE = H        size of the header pickle that follows
 *   bytes 8-11   uint32 LE = H - 4    the header pickle's payload size
 *   bytes 12-15  uint32 LE = J        byte length of the JSON string
 *   bytes 16..   J bytes of JSON, zero-padded to a 4-byte boundary
 *   bytes 8+H..  the data region; a packed file's "offset" is relative to its start
 *
 * Measured against the real dist/win-unpacked/resources/app.asar while writing this file:
 * 4, 25780, 25776, 25771, and the last packed file ends exactly at the end of the archive.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ALLOWED_TOP_LEVEL,
    PackageNotFoundError,
    UNPACKED_PACKAGE,
    checkTopLevel,
    checkUnpackedRegion,
    formatReport,
    inspectPackage,
    matchDenied,
    readAsarHeader
} from '../tools/ci/assert-package-contents.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'tools', 'ci', 'assert-package-contents.mjs');

/* ---------------------------------------------------------------------------------------- */
/* A synthetic archive, encoded independently of the reader                                  */
/* ---------------------------------------------------------------------------------------- */

interface SyntheticFile {
    path: string;
    content?: string;
    unpacked?: boolean;
    link?: string;
}

interface DirectoryNode {
    files: Record<string, HeaderNode>;
}

type HeaderNode = DirectoryNode | { size: number; offset?: string; unpacked?: boolean } | { link: string };

/*
 * Writes an archive the way the packager lays one out. It is written from the format, not by
 * calling anything in the script, so the reader is tested against an independent encoder rather
 * than against itself.
 */
function buildArchive(files: readonly SyntheticFile[]): Buffer {
    const root: DirectoryNode = { files: {} };
    const data: Buffer[] = [];
    let offset = 0;
    for (const file of files) {
        const segments = file.path.split('/');
        const name = segments.pop();
        if (name === undefined || name === '') throw new Error('fixture path has no file name: ' + file.path);
        let directory = root;
        for (const segment of segments) {
            const existing = directory.files[segment];
            if (existing === undefined) {
                const created: DirectoryNode = { files: {} };
                directory.files[segment] = created;
                directory = created;
            } else if ('files' in existing) {
                directory = existing;
            } else {
                throw new Error('fixture path crosses a file: ' + file.path);
            }
        }
        if (file.link !== undefined) {
            directory.files[name] = { link: file.link };
            continue;
        }
        const bytes = Buffer.from(file.content ?? '', 'utf8');
        if (file.unpacked === true) {
            directory.files[name] = { size: bytes.length, unpacked: true };
            continue;
        }
        directory.files[name] = { size: bytes.length, offset: String(offset) };
        data.push(bytes);
        offset += bytes.length;
    }
    const json = Buffer.from(JSON.stringify(root), 'utf8');
    const payloadBytes = Math.ceil((4 + json.length) / 4) * 4;
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(4 + payloadBytes, 4);
    prefix.writeUInt32LE(payloadBytes, 8);
    prefix.writeUInt32LE(json.length, 12);
    return Buffer.concat([prefix, json, Buffer.alloc(payloadBytes - 4 - json.length), ...data]);
}

/* A packaged app in miniature: build output, manifest, the unpacked driver, and one link. */
const FIXTURE: readonly SyntheticFile[] = [
    { path: 'package.json', content: '{"name":"workflow-timer","main":"./out/main/index.js"}' },
    { path: 'out/main/index.js', content: "require('./client.js');" },
    { path: 'out/renderer/index.html', content: '<!doctype html><title>Workflow</title>' },
    { path: 'out/renderer/assets/index.css', content: 'body{background:#101c22}' },
    { path: 'node_modules/better-sqlite3/package.json', content: '{"name":"better-sqlite3"}', unpacked: true },
    { path: 'node_modules/better-sqlite3/prebuilds/win32-x64.node', content: 'not a real addon', unpacked: true },
    { path: 'node_modules/.bin/example', link: '../example/cli.js' }
];

/* The listing the reader must recover, written out rather than derived from FIXTURE. */
const FIXTURE_LISTING = [
    'node_modules/.bin/example',
    'node_modules/better-sqlite3/package.json',
    'node_modules/better-sqlite3/prebuilds/win32-x64.node',
    'out/main/index.js',
    'out/renderer/assets/index.css',
    'out/renderer/index.html',
    'package.json'
];

const FIXTURE_BYTES = FIXTURE.reduce((total, file) => total + Buffer.byteLength(file.content ?? '', 'utf8'), 0);
const UNPACKED_ON_DISK = FIXTURE.filter((file) => file.unpacked === true).map((file) => file.path);

/* ---------------------------------------------------------------------------------------- */
/* Real packaged layouts on disk                                                              */
/* ---------------------------------------------------------------------------------------- */

const tempRoots: string[] = [];

afterAll(() => {
    for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-packaging-'));
    tempRoots.push(root);
    return root;
}

function writePackage(
    resourcesDir: string,
    files: readonly SyntheticFile[],
    unpackedOnDisk: readonly string[] = UNPACKED_ON_DISK
): void {
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, 'app.asar'), buildArchive(files));
    for (const rel of unpackedOnDisk) {
        const target = path.join(resourcesDir, 'app.asar.unpacked', ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'unpacked');
    }
}

function runCli(appDir: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [SCRIPT, appDir], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/* ---------------------------------------------------------------------------------------- */
/* The header reader                                                                          */
/* ---------------------------------------------------------------------------------------- */

describe('readAsarHeader - the listing comes from the archive itself', () => {
    it('recovers the exact path list from a synthetic archive, nested paths included', () => {
        const header = readAsarHeader(buildArchive(FIXTURE));
        expect(header.entries.map((entry) => entry.path)).toEqual(FIXTURE_LISTING);
    });

    it('reports every packed file at the offset where its bytes really are', () => {
        const archive = buildArchive(FIXTURE);
        const header = readAsarHeader(archive);
        expect(header.archiveBytes).toBe(archive.length);
        for (const file of FIXTURE) {
            const entry = header.entries.find((candidate) => candidate.path === file.path);
            expect(entry, file.path).toBeDefined();
            if (entry === undefined) continue;
            if (file.link !== undefined) {
                expect(entry.link).toBe(file.link);
                expect(entry.size).toBe(0);
                continue;
            }
            expect(entry.size, file.path).toBe(Buffer.byteLength(file.content ?? '', 'utf8'));
            expect(entry.unpacked, file.path).toBe(file.unpacked === true);
            if (file.unpacked === true) {
                expect(entry.offset, file.path).toBeUndefined();
                continue;
            }
            expect(entry.offset, file.path).toBeTypeOf('number');
            const start = header.dataOffset + (entry.offset ?? 0);
            expect(archive.subarray(start, start + entry.size).toString('utf8')).toBe(file.content);
        }
    });

    it('rejects a truncated archive - a half-written package - instead of listing what survived', () => {
        const archive = buildArchive(FIXTURE);
        expect(() => readAsarHeader(archive.subarray(0, archive.length - 3))).toThrow(/truncated or half-written/);
    });

    it('rejects a buffer too short to hold the 16-byte prefix', () => {
        expect(() => readAsarHeader(Buffer.alloc(10))).toThrow(/16/);
    });

    it('rejects a first pickle that is not the 4-byte size record', () => {
        const bad = Buffer.from(buildArchive(FIXTURE));
        bad.writeUInt32LE(8, 0);
        expect(() => readAsarHeader(bad)).toThrow(/expected 4/);
    });

    it('rejects a header that claims more bytes than the archive holds', () => {
        const archive = buildArchive(FIXTURE);
        const bad = Buffer.from(archive);
        bad.writeUInt32LE(archive.length * 2, 4);
        expect(() => readAsarHeader(bad)).toThrow(/claims/);
    });

    it('rejects a header that is not JSON', () => {
        const bad = Buffer.from(buildArchive(FIXTURE));
        bad[16] = 0x23;
        expect(() => readAsarHeader(bad)).toThrow(/not JSON/);
    });

    it('rejects an entry name that would climb out of the archive root', () => {
        const archive = buildArchive([{ path: '../escape.js', content: 'x' }]);
        expect(() => readAsarHeader(archive)).toThrow(/illegal entry name/);
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The denied-prefix matcher                                                                  */
/* ---------------------------------------------------------------------------------------- */

describe('matchDenied - material that must never reach a user', () => {
    // [packaged path, the rule that must catch it]. One representative per denied category.
    const DENIED: ReadonlyArray<readonly [string, string]> = [
        ['docs/index.html', 'docs/'],
        ['DOCS/index.html', 'docs/'],
        ['assets/icon.png', 'assets/'],
        ['baselines/v1.2.1/pixels/index@380x600.png', 'baselines/'],
        ['tools/baseline/vendor/tailwind.js', 'tools/'],
        ['tools/ci/assert-package-contents.mjs', 'tools/'],
        ['src/pages/index.html', 'src/pages/'],
        ['src/renderer/bottom-nav.js', 'src/renderer/*.js'],
        ['src/styles/common.css', 'src/styles/'],
        ['database/db.js', 'database/'],
        ['main.js', 'main.js'],
        ['preload.js', 'preload.js'],
        ['.planning/STATE.md', '.planning/'],
        ['RESTRUCTURE-BRIEF.md', 'RESTRUCTURE-BRIEF.md'],
        ['out/renderer/assets/index-DUDI11dz.js.map', '*.map'],
        ['out/main/index.ts', '*.ts|*.tsx|*.mts|*.cts'],
        ['src/renderer/src/App.tsx', '*.ts|*.tsx|*.mts|*.cts'],
        ['archive/krono.db', '*.db|*.db-wal|*.db-shm'],
        ['krono.db-wal', '*.db|*.db-wal|*.db-shm'],
        ['workflow-timer-1.2.1-x64-setup.exe', '*.exe|*.dmg'],
        ['Workflow-1.2.1-arm64.dmg', '*.exe|*.dmg']
    ];

    for (const [packagedPath, rule] of DENIED) {
        it('denies ' + packagedPath + ' under ' + rule, () => {
            const match = matchDenied(packagedPath);
            expect(match, packagedPath).not.toBeNull();
            expect(match?.rule).toBe(rule);
            expect(match?.reason.length ?? 0).toBeGreaterThan(0);
        });
    }

    it('allows the build output and the production dependencies', () => {
        const ALLOWED = [
            'package.json',
            'out/main/index.js',
            'out/preload/index.js',
            'out/renderer/index.html',
            'out/renderer/assets/index-JOtWstJr.css',
            'node_modules/better-sqlite3/lib/database.js',
            'node_modules/better-sqlite3/prebuilds/win32-x64.node'
        ];
        for (const packagedPath of ALLOWED) expect(matchDenied(packagedPath), packagedPath).toBeNull();
    });

    it('anchors directory rules at the archive root, so the bundler\'s own out/renderer/assets/ is not "assets/"', () => {
        expect(matchDenied('out/renderer/assets/material-symbols-outlined-CQbRTMbb.woff2')).toBeNull();
        expect(matchDenied('node_modules/some-package/docs/guide.md')).toBeNull();
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The top-level allowlist                                                                     */
/* ---------------------------------------------------------------------------------------- */

describe('checkTopLevel - only the build output, the manifest and production dependencies', () => {
    it('accepts exactly out/, package.json and node_modules/', () => {
        expect([...ALLOWED_TOP_LEVEL].sort()).toEqual(['node_modules', 'out', 'package.json']);
        expect(checkTopLevel(FIXTURE_LISTING)).toEqual([]);
    });

    it('rejects an unexpected top-level entry, naming each one', () => {
        const listing = [...FIXTURE_LISTING, 'LICENSE', 'src/main/index.ts', 'google-apps-script.gs'];
        expect(checkTopLevel(listing)).toEqual(['LICENSE', 'src/main/index.ts', 'google-apps-script.gs']);
    });

    it('treats package.json as a file, not as a directory to hide things under', () => {
        expect(checkTopLevel(['package.json/hidden.js'])).toEqual(['package.json/hidden.js']);
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The unpacked-from-archive region                                                            */
/* ---------------------------------------------------------------------------------------- */

describe('checkUnpackedRegion - the native addon and nothing else', () => {
    const DRIVER = [
        'node_modules/better-sqlite3/package.json',
        'node_modules/better-sqlite3/lib/binding.js',
        'node_modules/better-sqlite3/prebuilds/win32-x64.node'
    ];

    it('names better-sqlite3 as the only permitted package', () => {
        expect(UNPACKED_PACKAGE).toBe('better-sqlite3');
        expect(checkUnpackedRegion(DRIVER)).toEqual({ offenders: [], problems: [] });
    });

    it('rejects a second package appearing beside the driver', () => {
        const result = checkUnpackedRegion([...DRIVER, 'node_modules/bindings/bindings.js']);
        expect(result.offenders).toEqual(['node_modules/bindings/bindings.js']);
    });

    it('matches the package on a directory boundary, not as a name prefix', () => {
        const result = checkUnpackedRegion([...DRIVER, 'node_modules/better-sqlite3-extra/evil.node']);
        expect(result.offenders).toEqual(['node_modules/better-sqlite3-extra/evil.node']);
    });

    it('reports an empty region as a problem: the addon cannot be loaded from inside the archive', () => {
        const result = checkUnpackedRegion([]);
        expect(result.offenders).toEqual([]);
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toMatch(/native addon/);
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The whole inspection, over real layouts on disk                                             */
/* ---------------------------------------------------------------------------------------- */

describe('inspectPackage - asserts on the artifact, for both platform layouts', () => {
    it('passes a Windows unpacked directory that holds only allowlisted files', () => {
        const appDir = path.join(tempRoot(), 'win-unpacked');
        writePackage(path.join(appDir, 'resources'), FIXTURE);

        const inspection = inspectPackage(appDir);

        expect(inspection.failures).toEqual([]);
        expect(inspection.ok).toBe(true);
        expect(inspection.resourcesDir).toBe(path.join(appDir, 'resources'));
        expect(inspection.fileCount).toBe(FIXTURE_LISTING.length);
        expect(inspection.totalBytes).toBe(FIXTURE_BYTES);
        expect(inspection.unpackedOnDisk).toEqual([...UNPACKED_ON_DISK].sort());
        expect(inspection.largest[0]?.path).toBe('out/renderer/index.html');
        expect(formatReport(inspection)).toMatch(new RegExp('^ALLOWLIST_OK files=' + String(FIXTURE_LISTING.length) + ' bytes=' + String(FIXTURE_BYTES) + ' ', 'm'));
    });

    it('finds the resources directory inside a macOS application bundle', () => {
        const appDir = path.join(tempRoot(), 'mac-arm64');
        const resourcesDir = path.join(appDir, 'Workflow.app', 'Contents', 'Resources');
        writePackage(resourcesDir, FIXTURE);

        expect(inspectPackage(appDir).resourcesDir).toBe(resourcesDir);
        expect(inspectPackage(appDir).ok).toBe(true);
        expect(inspectPackage(path.join(appDir, 'Workflow.app')).resourcesDir).toBe(resourcesDir);
    });

    it('fails, naming every offending path, when the documentation directory is packaged', () => {
        const appDir = path.join(tempRoot(), 'win-unpacked');
        writePackage(path.join(appDir, 'resources'), [
            ...FIXTURE,
            { path: 'docs/index.html', content: '<html></html>' },
            { path: 'docs/assets/logo.png', content: 'png' }
        ]);

        const inspection = inspectPackage(appDir);
        const report = formatReport(inspection);

        expect(inspection.ok).toBe(false);
        expect(inspection.denied.map((entry) => entry.path)).toEqual(['docs/assets/logo.png', 'docs/index.html']);
        expect(inspection.topLevelOffenders).toEqual(['docs/assets/logo.png', 'docs/index.html']);
        expect(report).not.toMatch(/ALLOWLIST_OK/);
        expect(report).toContain('docs/index.html');
        expect(report).toContain('docs/assets/logo.png');
    });

    it('fails when a second package joins the driver in the unpacked region on disk', () => {
        const appDir = path.join(tempRoot(), 'win-unpacked');
        writePackage(path.join(appDir, 'resources'), FIXTURE, [...UNPACKED_ON_DISK, 'node_modules/bindings/bindings.js']);

        const inspection = inspectPackage(appDir);

        expect(inspection.ok).toBe(false);
        expect(inspection.unpackedRegion.offenders).toEqual(['node_modules/bindings/bindings.js']);
    });

    it('fails when the header marks a file unpacked that is not on disk', () => {
        const appDir = path.join(tempRoot(), 'win-unpacked');
        writePackage(path.join(appDir, 'resources'), FIXTURE, ['node_modules/better-sqlite3/package.json']);

        const inspection = inspectPackage(appDir);

        expect(inspection.ok).toBe(false);
        expect(inspection.missingUnpacked).toEqual(['node_modules/better-sqlite3/prebuilds/win32-x64.node']);
    });

    it('refuses to report success on a directory that holds no packaged application', () => {
        const empty = tempRoot();
        let caught: unknown;
        try {
            inspectPackage(empty);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(PackageNotFoundError);
        if (!(caught instanceof PackageNotFoundError)) return;
        expect(caught.message).toContain(empty);
        expect(caught.searched).toContain(path.join(empty, 'resources'));
        expect(caught.searched).toContain(path.join(empty, 'Contents', 'Resources'));
    });
});

/* ---------------------------------------------------------------------------------------- */
/* The CLI, as a real process - the exit code is what CI acts on                               */
/* ---------------------------------------------------------------------------------------- */

describe('the CLI exit codes', () => {
    it('exits 0 and prints ALLOWLIST_OK with a file count and byte total for a clean package', () => {
        const appDir = path.join(tempRoot(), 'win-unpacked');
        writePackage(path.join(appDir, 'resources'), FIXTURE);
        const result = runCli(appDir);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toMatch(/^ALLOWLIST_OK files=\d+ bytes=\d+ /m);
    });

    it('exits 1 and names the offending paths for a widened package', () => {
        const appDir = path.join(tempRoot(), 'win-unpacked');
        writePackage(path.join(appDir, 'resources'), [...FIXTURE, { path: 'docs/index.html', content: 'x' }]);
        const result = runCli(appDir);
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('docs/index.html');
        expect(result.stdout).not.toMatch(/ALLOWLIST_OK/);
    });

    it('exits 2 and names the directory it searched when no packaged application is there', () => {
        const empty = tempRoot();
        const result = runCli(empty);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(empty);
    });
});

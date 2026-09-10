#!/usr/bin/env node
/*
 * BUILD-08 - prove that the PACKAGED application holds only what the app needs to run, by reading
 * the artifact itself rather than the configuration that was supposed to produce it.
 *
 * The failure this prevents is concrete, and it has already happened once. v1.2.1's builder block
 * said files: ["**\/*"], so every installer shipped the whole repository: the GitHub Pages site under
 * docs/ at roughly 3.9 MB, the top-level assets/ at roughly 4 MB, and three copies of the same 1.8 MB
 * image. Since Phase 1 the repository holds worse material than dead weight. baselines/ carries
 * parity screenshots and computed-style records captured from the author's own running
 * application, and tools/baseline/vendor/ carries byte-exact copies of what a content delivery
 * network and Google Fonts served on one particular day. None of that is something a person
 * downloading the app should receive: it is evidence about one person's environment, and an
 * installer redistributes it to everyone who downloads it.
 *
 * electron-builder.yml now carries an allowlist (plan 02-01). That is a statement of intent. What
 * ships is whatever the packager actually wrote into app.asar, and a pattern that is supposed to
 * exclude a directory and an archive that actually excludes it are different claims - only the
 * second one reaches users. So this script never reads the configuration. It opens the packaged
 * archive, reads the file listing from the archive's own header, and checks every path:
 *
 *   1. no path falls under a denied prefix - the documentation site, the top-level assets, the
 *      baselines, the tooling including its vendored capture assets, the legacy v1.2.1 tree that
 *      stays on disk until Phase 7 (D-01), the planning directory, the restructure brief - and no
 *      source map, TypeScript source, database or installer is packaged anywhere;
 *   2. every top-level entry is one the app needs: the build output (out/), and the manifest and
 *      production dependency directory the packager always adds;
 *   3. the region unpacked from the archive holds the better-sqlite3 package and nothing else. The
 *      native addon is the one file that cannot be dlopen'd from inside the archive (BUILD-05);
 *      anything that joins it sits outside the archive for no reason.
 *
 * Reading the header needs no dependency. The layout, from the format itself:
 *
 *   bytes 0-3    uint32 LE = 4        the first pickle's payload size - it holds one uint32
 *   bytes 4-7    uint32 LE = H        size of the header pickle that follows
 *   bytes 8-11   uint32 LE = H - 4    the header pickle's payload size
 *   bytes 12-15  uint32 LE = J        byte length of the JSON string
 *   bytes 16..   J bytes of JSON: { "files": { <name>: <node> } }, where a directory node is
 *                { "files": ... }, a file { "size", "offset" } or { "size", "unpacked": true },
 *                and a link { "link" }
 *   bytes 8+H..  the data region; a packed file's "offset" (a decimal string) is relative to it
 *
 * A packed entry whose offset plus size runs past the end of the archive is reported as a truncated
 * or half-written archive rather than listed. A partial listing that passes is exactly the silent
 * success this script exists to prevent.
 *
 * It also prints the complete listing, the byte total and the ten largest entries, so the later
 * bundle-size work starts from a measurement rather than an assumption.
 *
 * Usage:
 *   node tools/ci/assert-package-contents.mjs <packaged app directory>
 *     e.g. dist/win-unpacked, dist/win-arm64-unpacked, dist/mac, dist/mac-arm64, or a Workflow.app
 *
 * Exit codes: 0 the package holds only allowlisted files; 1 it does not, or its archive could not be
 * read; 2 no argument was given, or no packaged application is where one was expected.
 *
 * Fix a failure in electron-builder.yml (files: and asarUnpack:), never by widening this script.
 *
 * The pure pieces - the header reader, the denied-prefix matcher, the top-level allowlist check and
 * the unpacked-region check - are exported, the way tools/baseline/probe-userdata.mjs exports its
 * pieces, so tests/packaging.test.ts checks them on every push without a packaged binary present.
 * Their types are declared in assert-package-contents.d.mts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'tools/ci/assert-package-contents.mjs';
const ASAR_NAME = 'app.asar';
const UNPACKED_DIR_NAME = 'app.asar.unpacked';

/*
 * The top-level entries a packaged app may hold. out/ is the only thing electron-builder.yml's
 * allowlist names; the packager adds package.json and the production node_modules itself.
 * package.json is a file and the other two are directories, and the check below holds each to that.
 */
const ALLOWED_TOP_LEVEL_DIRS = Object.freeze(['out', 'node_modules']);
const ALLOWED_TOP_LEVEL_FILES = Object.freeze(['package.json']);
export const ALLOWED_TOP_LEVEL = Object.freeze([...ALLOWED_TOP_LEVEL_DIRS, ...ALLOWED_TOP_LEVEL_FILES]);

/* The one package permitted outside the archive: the SQLite driver, for its native addon. */
export const UNPACKED_PACKAGE = 'better-sqlite3';
const UNPACKED_PREFIX = 'node_modules/' + UNPACKED_PACKAGE + '/';

export const LARGEST_COUNT = 10;

/* ---------------------------------------------------------------------------------------- */
/* What must never be packaged                                                                 */
/* ---------------------------------------------------------------------------------------- */

function prefixRule(rule, reason) {
    const lower = rule.toLowerCase();
    return { rule, reason, test: (p) => p.toLowerCase().startsWith(lower) };
}

function exactRule(rule, reason) {
    const lower = rule.toLowerCase();
    return { rule, reason, test: (p) => p.toLowerCase() === lower };
}

function patternRule(rule, regex, reason) {
    return { rule, reason, test: (p) => regex.test(p) };
}

/*
 * Directory rules are anchored at the archive root: the bundler's own out/renderer/assets/ is not
 * the repository's assets/. Comparison ignores case, because the Windows and macOS filesystems the
 * packager reads from do. The first matching rule is the one reported.
 */
const DENIED_RULES = Object.freeze([
    prefixRule('docs/', 'the GitHub Pages site, roughly 3.9 MB - unrelated to the application'),
    prefixRule('assets/', 'top-level repository assets, roughly 4 MB, including three copies of one 1.8 MB image'),
    prefixRule('baselines/', "parity screenshots and computed-style records captured from the author's own running app"),
    prefixRule('tools/', 'repository tooling, including tools/baseline/vendor/ - byte-exact copies of what a CDN served on one day'),
    prefixRule('src/pages/', 'the legacy v1.2.1 HTML pages, kept on disk until Phase 7 (D-01) and never shipped'),
    patternRule('src/renderer/*.js', /^src\/renderer\/[^/]+\.js$/i, 'a legacy v1.2.1 flat renderer script (D-01)'),
    prefixRule('src/styles/', 'the legacy v1.2.1 stylesheets (D-01)'),
    prefixRule('database/', 'the legacy v1.2.1 database module (D-01)'),
    exactRule('main.js', 'the legacy v1.2.1 main-process entry script (D-01)'),
    exactRule('preload.js', 'the legacy v1.2.1 preload script (D-01)'),
    prefixRule('.planning/', 'planning artifacts, which cite unpatched defects in the shipped v1.2.1'),
    exactRule('RESTRUCTURE-BRIEF.md', 'the restructure brief, which cites unpatched defects in the shipped v1.2.1'),
    patternRule('*.map', /\.map$/i, 'a source map - it reconstructs source the app does not need to run'),
    patternRule('*.ts|*.tsx|*.mts|*.cts', /\.(ts|tsx|mts|cts)$/i, 'TypeScript source - the app runs the compiled output'),
    patternRule('*.db|*.db-wal|*.db-shm', /\.db(-wal|-shm)?$/i, "a SQLite database - an archived database is one person's data"),
    patternRule('*.exe|*.dmg', /\.(exe|dmg)$/i, 'an installer archive')
]);

/* ---------------------------------------------------------------------------------------- */
/* Pure pieces                                                                                 */
/* ---------------------------------------------------------------------------------------- */

function compareCodeUnits(a, b) {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

function malformed(why) {
    return new Error('malformed asar header: ' + why);
}

/*
 * Walks one directory node of the header. Every name is checked before it is joined into a path:
 * an empty name, '.', '..' or a separator would let a listing name something outside the archive
 * root, and a reader that accepted it would be checking a different tree than the one it reports.
 */
function walkHeader(node, prefix, entries, dataBytes) {
    const files = node.files;
    if (files === null || typeof files !== 'object' || Array.isArray(files)) {
        throw malformed('the node at ' + (prefix || 'the archive root') + ' has no "files" object');
    }
    for (const [name, child] of Object.entries(files)) {
        if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
            throw malformed('illegal entry name ' + JSON.stringify(name) + ' under ' + (prefix || 'the archive root'));
        }
        const childPath = prefix ? prefix + '/' + name : name;
        if (child === null || typeof child !== 'object' || Array.isArray(child)) {
            throw malformed('entry ' + childPath + ' is not an object');
        }
        if ('files' in child) {
            walkHeader(child, childPath, entries, dataBytes);
            continue;
        }
        if (typeof child.link === 'string') {
            entries.push({ path: childPath, size: 0, unpacked: false, link: child.link });
            continue;
        }
        const size = child.size;
        if (!Number.isSafeInteger(size) || size < 0) {
            throw malformed('entry ' + childPath + ' has no valid size (' + JSON.stringify(size) + ')');
        }
        if (child.unpacked === true) {
            entries.push({ path: childPath, size, unpacked: true });
            continue;
        }
        const offset = typeof child.offset === 'string' || typeof child.offset === 'number' ? Number(child.offset) : NaN;
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw malformed('entry ' + childPath + ' has no valid offset (' + JSON.stringify(child.offset) + ')');
        }
        if (offset + size > dataBytes) {
            throw malformed('entry ' + childPath + ' ends at byte ' + (offset + size) + ' of the data region, but the ' +
                'archive holds only ' + dataBytes + ' - a truncated or half-written archive');
        }
        entries.push({ path: childPath, size, unpacked: false, offset });
    }
}

/*
 * The header reader. `buffer` must hold at least the prefix and the whole header; `archiveBytes` is
 * the archive's full length (the default assumes `buffer` is the whole archive), against which every
 * packed entry's extent is checked. Returns every file and link, sorted by path.
 */
export function readAsarHeader(buffer, archiveBytes = buffer.length) {
    if (buffer.length < 16) {
        throw malformed('the archive is ' + buffer.length + ' bytes, shorter than the 16-byte fixed prefix');
    }
    const sizePickle = buffer.readUInt32LE(0);
    if (sizePickle !== 4) {
        throw malformed('the first pickle declares ' + sizePickle + ' bytes, expected 4');
    }
    const headerBytes = buffer.readUInt32LE(4);
    const dataOffset = 8 + headerBytes;
    if (dataOffset > archiveBytes) {
        throw malformed('the header claims ' + headerBytes + ' bytes but the archive holds only ' +
            (archiveBytes - 8) + ' after the 8-byte prefix - a truncated or half-written archive');
    }
    if (buffer.length < dataOffset) {
        throw malformed('only ' + buffer.length + ' bytes were supplied and the header ends at byte ' + dataOffset);
    }
    const payloadBytes = buffer.readUInt32LE(8);
    if (payloadBytes + 4 !== headerBytes) {
        throw malformed('the header pickle payload is ' + payloadBytes + ' bytes, expected ' + (headerBytes - 4));
    }
    const jsonBytes = buffer.readUInt32LE(12);
    if (jsonBytes + 4 > payloadBytes) {
        throw malformed('the JSON string claims ' + jsonBytes + ' bytes, more than the ' + payloadBytes + '-byte payload');
    }
    let header;
    try {
        header = JSON.parse(buffer.toString('utf8', 16, 16 + jsonBytes));
    } catch (error) {
        throw malformed('the header is not JSON (' + error.message + ')');
    }
    if (header === null || typeof header !== 'object') {
        throw malformed('the header JSON is not an object');
    }
    const entries = [];
    walkHeader(header, '', entries, archiveBytes - dataOffset);
    entries.sort((a, b) => compareCodeUnits(a.path, b.path));
    return { entries, headerBytes, dataOffset, archiveBytes };
}

/* The denied-prefix matcher: the first rule a packaged path falls under, or null. */
export function matchDenied(packagedPath) {
    const normalized = packagedPath.split('\\').join('/');
    for (const denied of DENIED_RULES) {
        if (denied.test(normalized)) return { rule: denied.rule, reason: denied.reason };
    }
    return null;
}

/* The top-level allowlist check: every path whose first segment is not an allowed entry, in input order. */
export function checkTopLevel(paths) {
    return paths.filter((p) => {
        const slash = p.indexOf('/');
        if (slash === -1) return !ALLOWED_TOP_LEVEL_FILES.includes(p);
        return !ALLOWED_TOP_LEVEL_DIRS.includes(p.slice(0, slash));
    });
}

/*
 * The unpacked-region check, over forward-slash paths relative to app.asar.unpacked. better-sqlite3
 * is the only package permitted there, matched on its directory boundary so that a sibling named
 * better-sqlite3-anything is not waved through. A region holding no .node file at all is reported
 * too: the driver would then be looking for its binding inside the archive, where it cannot load.
 */
export function checkUnpackedRegion(paths) {
    const offenders = paths.filter((p) => !p.startsWith(UNPACKED_PREFIX));
    const problems = [];
    if (!paths.some((p) => p.startsWith(UNPACKED_PREFIX) && p.endsWith('.node'))) {
        problems.push('no native addon (.node) under ' + UNPACKED_PREFIX + ' - ' + UNPACKED_PACKAGE +
            ' cannot load its binding from inside the archive (BUILD-05)');
    }
    return { offenders, problems };
}

/* ---------------------------------------------------------------------------------------- */
/* Reading the artifact                                                                        */
/* ---------------------------------------------------------------------------------------- */

export class PackageNotFoundError extends Error {
    constructor(appDir, searched) {
        super('no packaged application under ' + appDir + ' - looked for ' + ASAR_NAME + ' in: ' +
            searched.join(', ') + '. Point this script at the directory electron-builder wrote: ' +
            'dist/win-unpacked, dist/win-arm64-unpacked, dist/mac or dist/mac-arm64.');
        this.name = 'PackageNotFoundError';
        this.appDir = appDir;
        this.searched = Object.freeze([...searched]);
    }
}

function readAt(fd, length) {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
        const read = fs.readSync(fd, buffer, filled, length - filled, filled);
        if (read === 0) break;
        filled += read;
    }
    return buffer.subarray(0, filled);
}

/* Reads only the prefix and the header, never the data region; the file's size bounds every extent. */
export function readAsarFile(asarPath) {
    const archiveBytes = fs.statSync(asarPath).size;
    const fd = fs.openSync(asarPath, 'r');
    try {
        const prefix = readAt(fd, Math.min(16, archiveBytes));
        if (prefix.length < 16) return readAsarHeader(prefix, archiveBytes);
        const wanted = Math.min(archiveBytes, 8 + prefix.readUInt32LE(4));
        return readAsarHeader(readAt(fd, wanted), archiveBytes);
    } finally {
        fs.closeSync(fd);
    }
}

function isFile(candidate) {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/*
 * The resources directory for both platform layouts: the Windows unpacked directory keeps it at
 * resources/, a macOS application bundle at Contents/Resources/, and electron-builder's macOS output
 * directory holds the bundle one level down. A directory holding none of them is an error naming
 * every place that was searched - never an empty scan that reports success.
 */
export function resolveResourcesDir(appDir) {
    const root = path.resolve(appDir);
    const candidates = [path.join(root, 'resources'), path.join(root, 'Contents', 'Resources'), root];
    let children = [];
    try {
        children = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        /* a missing or unreadable directory falls through to the error below */
    }
    for (const child of children.filter((c) => c.isDirectory() && c.name.endsWith('.app')).map((c) => c.name).sort()) {
        candidates.push(path.join(root, child, 'Contents', 'Resources'));
    }
    for (const candidate of candidates) {
        if (isFile(path.join(candidate, ASAR_NAME))) return candidate;
    }
    throw new PackageNotFoundError(root, candidates);
}

/*
 * Every non-directory entry under `dir`, as sorted forward-slash relative paths. Symbolic links are
 * reported rather than followed: a link in the unpacked region is itself something to account for.
 */
export function listFilesUnder(dir) {
    const found = [];
    const walk = (absolute, relative) => {
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
            const childRelative = relative ? relative + '/' + entry.name : entry.name;
            if (entry.isDirectory()) walk(path.join(absolute, entry.name), childRelative);
            else found.push(childRelative);
        }
    };
    if (fs.existsSync(dir)) walk(dir, '');
    return found.sort(compareCodeUnits);
}

export function inspectPackage(appDir) {
    const resourcesDir = resolveResourcesDir(appDir);
    const asarPath = path.join(resourcesDir, ASAR_NAME);
    const { entries } = readAsarFile(asarPath);
    const paths = entries.map((entry) => entry.path);

    const denied = [];
    for (const packagedPath of paths) {
        const match = matchDenied(packagedPath);
        if (match) denied.push({ path: packagedPath, ...match });
    }
    const topLevelOffenders = checkTopLevel(paths);

    const unpackedOnDisk = listFilesUnder(path.join(resourcesDir, UNPACKED_DIR_NAME));
    const unpackedRegion = checkUnpackedRegion(unpackedOnDisk);
    const headerUnpackedPaths = entries.filter((entry) => entry.unpacked).map((entry) => entry.path);
    const headerUnpacked = checkUnpackedRegion(headerUnpackedPaths);
    const onDisk = new Set(unpackedOnDisk);
    const missingUnpacked = headerUnpackedPaths.filter((p) => !onDisk.has(p));

    const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
    const largest = [...entries]
        .sort((a, b) => b.size - a.size || compareCodeUnits(a.path, b.path))
        .slice(0, LARGEST_COUNT);

    const failures = [];
    for (const d of denied) failures.push('denied: ' + d.path + ' [' + d.rule + '] ' + d.reason);
    for (const p of topLevelOffenders) {
        failures.push('outside the top-level allowlist (' + ALLOWED_TOP_LEVEL.join(', ') + '): ' + p);
    }
    for (const p of unpackedRegion.offenders) failures.push('unpacked beside the driver: ' + UNPACKED_DIR_NAME + '/' + p);
    for (const p of unpackedRegion.problems) failures.push(UNPACKED_DIR_NAME + ' on disk: ' + p);
    for (const p of headerUnpacked.offenders) failures.push('the header marks this unpacked, outside ' + UNPACKED_PREFIX + ': ' + p);
    for (const p of headerUnpacked.problems) failures.push('the header: ' + p);
    for (const p of missingUnpacked) failures.push('the header marks this unpacked but it is not on disk: ' + p);

    return {
        ok: failures.length === 0,
        appDir: path.resolve(appDir),
        resourcesDir,
        asarPath,
        entries,
        fileCount: entries.length,
        totalBytes,
        largest,
        denied,
        topLevelOffenders,
        unpackedOnDisk,
        unpackedRegion,
        headerUnpacked,
        missingUnpacked,
        failures
    };
}

function mebibytes(bytes) {
    return (bytes / 1048576).toFixed(2) + ' MiB';
}

function entryLine(entry) {
    return String(entry.size).padStart(10) + (entry.unpacked ? '  U  ' : '     ') + entry.path +
        (entry.link === undefined ? '' : ' -> ' + entry.link);
}

export function formatReport(inspection) {
    const unpackedCount = inspection.entries.filter((entry) => entry.unpacked).length;
    const lines = [
        SCRIPT_NAME + ': ' + inspection.asarPath,
        SCRIPT_NAME + ': ' + inspection.fileCount + ' packaged entries, ' + inspection.totalBytes + ' bytes (' +
            mebibytes(inspection.totalBytes) + '), ' + unpackedCount + ' of them unpacked from the archive',
        '--- packaged paths: bytes, U when unpacked, path ---',
        ...inspection.entries.map(entryLine),
        '--- the ' + inspection.largest.length + ' largest entries ---',
        ...inspection.largest.map(entryLine)
    ];
    if (inspection.ok) {
        lines.push('ALLOWLIST_OK files=' + inspection.fileCount + ' bytes=' + inspection.totalBytes +
            ' unpacked=' + unpackedCount + ' ' + inspection.appDir);
    } else {
        lines.push('--- ' + inspection.failures.length + ' violation(s) ---');
        for (const failure of inspection.failures) lines.push('ALLOWLIST_FAIL ' + failure);
        lines.push('::error::ALLOWLIST_VIOLATION ' + inspection.failures.length + ' violation(s) in ' +
            inspection.asarPath + ' - the packaged artifact holds material outside the allowlist (BUILD-08). ' +
            'Fix electron-builder.yml (files: and asarUnpack:), not this script.');
    }
    return lines.join('\n');
}

/* ---------------------------------------------------------------------------------------- */
/* CLI                                                                                        */
/* ---------------------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const target = process.argv[2];
    // exitCode rather than process.exit(): a pending write to a Windows pipe is not flushed by an
    // immediate exit, and on a failure the listing is the evidence.
    if (!target) {
        console.error(SCRIPT_NAME + ': usage: node ' + SCRIPT_NAME + ' <packaged app directory>, e.g. dist/win-unpacked');
        process.exitCode = 2;
    } else {
        try {
            const inspection = inspectPackage(target);
            const report = formatReport(inspection);
            if (inspection.ok) {
                console.log(report);
            } else {
                console.error(report);
                process.exitCode = 1;
            }
        } catch (error) {
            if (error instanceof PackageNotFoundError) {
                console.error(SCRIPT_NAME + ': ' + error.message);
                console.error('::error::PACKAGE_NOT_FOUND nothing to inspect under ' + error.appDir);
                process.exitCode = 2;
            } else {
                console.error(SCRIPT_NAME + ': ' + (error instanceof Error ? error.message : String(error)));
                console.error('::error::PACKAGE_UNREADABLE the packaged archive could not be read, so its contents are unproven');
                process.exitCode = 1;
            }
        }
    }
}

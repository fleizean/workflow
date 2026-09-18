/*
 * SPA-09 (trap C4), read off the bytes the build actually emitted.
 *
 * 9 sites in v1.2.1 set `font-variation-settings: 'FILL' 1` - the active bottom-nav tab, the streak flame, the
 * pomodoro pizza, the play control, the trophy, two Work History headings. If the woff2 in out/renderer carries no
 * FILL axis, every one renders outlined and nothing fails: the CSS is valid, the glyph is drawn, it is simply the
 * wrong glyph. STACK.md recorded the opposite of what is true here, so this file answers the question from the
 * file rather than from the note. (The npm font does carry FILL 0..1; the note was wrong on both halves.)
 *
 * The parse is a WOFF2 table-directory walk, a brotli decompression and an fvar read - more code than a size
 * check, and that is the point: a subsetted font would still be a valid woff2 of the right family.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { repoRoot } from './helpers/ts-imports';

const BUILT_DIR = 'out/renderer';
const BUILD_SCRIPT = 'npm run build';
const REQUIRE_BUILD_ENV = 'WORKFLOW_REQUIRE_BUILD_OUTPUT';

/** The family whose FILL axis the app depends on, and the axis it needs. */
const ICON_FAMILY = 'Material Symbols Outlined';
const FILL_AXIS = 'FILL';

// WOFF2 spec, table 1: the 63 known table tags, indexed by the low six bits of an entry's flags byte.
const KNOWN_TAGS = [
    'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep',
    'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE',
    'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt',
    'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar',
    'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'
];

const WOFF2_HEADER_BYTES = 48;
const ARBITRARY_TAG = 63;
const FIXED_16_16 = 65536;

interface Axis {
    tag: string;
    min: number;
    def: number;
    max: number;
}

const MISSING_BUILD =
    BUILT_DIR + ' does not exist, so the emitted font has NOT been checked. Run `' + BUILD_SCRIPT +
    '` and re-run this file. (Set ' + REQUIRE_BUILD_ENV + '=1 to make a missing build fail instead of skip.)';

const hasBuild = fs.existsSync(path.join(repoRoot, BUILT_DIR));
const buildRequired = process.env[REQUIRE_BUILD_ENV] === '1';

const walk = (absDir: string): string[] => {
    const found: string[] = [];
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const full = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
            found.push(...walk(full));
        } else if (entry.isFile()) {
            found.push(path.relative(repoRoot, full).split(path.sep).join('/'));
        }
    }
    return found.sort();
};

/** UIntBase128, the WOFF2 variable-length integer. */
function readBase128(bytes: Buffer, at: number): { value: number; next: number } {
    let value = 0;
    let cursor = at;
    for (let i = 0; i < 5; i++) {
        const byte = bytes[cursor] ?? 0;
        cursor += 1;
        value = (value << 7) | (byte & 0x7f);
        if ((byte & 0x80) === 0) {
            return { value: value >>> 0, next: cursor };
        }
    }
    throw new Error('malformed WOFF2: a UIntBase128 ran past five bytes');
}

/**
 * The decompressed bytes of one table. The WOFF2 body is a single brotli stream holding every table back to back
 * in directory order with no padding, so a table is found by summing the lengths before it.
 */
function tableOf(woff2: Buffer, wanted: string): Buffer | undefined {
    if (woff2.toString('ascii', 0, 4) !== 'wOF2') {
        throw new Error('not a WOFF2 file');
    }
    const tableCount = woff2.readUInt16BE(12);
    const entries: { tag: string; length: number }[] = [];
    let cursor = WOFF2_HEADER_BYTES;

    for (let i = 0; i < tableCount; i++) {
        const flags = woff2[cursor] ?? 0;
        cursor += 1;
        const index = flags & 0x3f;
        let tag: string;
        if (index === ARBITRARY_TAG) {
            tag = woff2.toString('ascii', cursor, cursor + 4);
            cursor += 4;
        } else {
            tag = KNOWN_TAGS[index] ?? '????';
        }
        const transform = (flags >> 6) & 0x3;
        const original = readBase128(woff2, cursor);
        cursor = original.next;
        let length = original.value;
        // glyf and loca are transformed unless transform is 3; every other table is transformed unless it is 0.
        const transformed = tag === 'glyf' || tag === 'loca' ? transform !== 3 : transform !== 0;
        if (transformed) {
            const actual = readBase128(woff2, cursor);
            cursor = actual.next;
            length = actual.value;
        }
        entries.push({ tag, length });
    }

    const body = zlib.brotliDecompressSync(woff2.subarray(cursor));
    let offset = 0;
    for (const entry of entries) {
        if (entry.tag === wanted) {
            return body.subarray(offset, offset + entry.length);
        }
        offset += entry.length;
    }
    return undefined;
}

/** OpenType fvar: the variation axes a variable font exposes, with their ranges. */
function axesOf(fvar: Buffer): Axis[] {
    const axesOffset = fvar.readUInt16BE(4);
    const axisCount = fvar.readUInt16BE(8);
    const axisSize = fvar.readUInt16BE(10);
    const axes: Axis[] = [];
    for (let i = 0; i < axisCount; i++) {
        const at = axesOffset + i * axisSize;
        axes.push({
            tag: fvar.toString('ascii', at, at + 4),
            min: fvar.readInt32BE(at + 4) / FIXED_16_16,
            def: fvar.readInt32BE(at + 8) / FIXED_16_16,
            max: fvar.readInt32BE(at + 12) / FIXED_16_16
        });
    }
    return axes;
}

const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The url()s of every @font-face declaring the given family, as emitted-relative paths. */
function faceUrls(family: string, cssFile: string): string[] {
    const css = stripCssComments(fs.readFileSync(path.join(repoRoot, cssFile), 'utf8'));
    const urls: string[] = [];
    for (const face of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
        const body = face[1] ?? '';
        const declared = /font-family\s*:\s*(['"]?)([^;'"]+)\1/i.exec(body)?.[2]?.trim();
        if (declared !== family) {
            continue;
        }
        for (const url of body.matchAll(/url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi)) {
            const target = (url[2] ?? '').split(/[?#]/)[0] ?? '';
            if (target !== '' && !target.startsWith('data:')) {
                urls.push(path.posix.join(path.posix.dirname(cssFile), target));
            }
        }
    }
    return urls;
}

describe('SPA-09 (C4): the icon font the build emitted is the variable one, with a FILL axis', () => {
    if (!hasBuild) {
        if (buildRequired) {
            it('the renderer build output exists', () => {
                throw new Error(MISSING_BUILD);
            });
        } else {
            console.warn('\ntests/bundled-fonts.test.ts: SKIPPED - ' + MISSING_BUILD + '\n');
            it.skip('SKIPPED - ' + MISSING_BUILD, () => undefined);
        }
        return;
    }

    const emitted = walk(path.join(repoRoot, BUILT_DIR));
    const iconFontFiles = (): string[] =>
        emitted.filter((file) => file.endsWith('.css')).flatMap((file) => faceUrls(ICON_FAMILY, file));

    it('emits an @font-face for "' + ICON_FAMILY + '" pointing at a file in the bundle', () => {
        const files = iconFontFiles();
        expect(files.length, 'no @font-face for ' + ICON_FAMILY + ' in the emitted CSS').toBeGreaterThan(0);
        for (const file of files) {
            expect(fs.existsSync(path.join(repoRoot, file)), file + ' is declared but was not emitted').toBe(true);
        }
    });

    it('carries an fvar table, so it is a variable font rather than a static instance', () => {
        for (const file of iconFontFiles()) {
            const fvar = tableOf(fs.readFileSync(path.join(repoRoot, file)), 'fvar');
            expect(
                fvar,
                file + ' has no fvar table. A static icon font renders every icon outlined and fails nothing: ' +
                'the CSS is valid, a glyph is drawn, it is just the wrong one (C4).'
            ).toBeDefined();
        }
    });

    it('exposes ' + FILL_AXIS + ' from 0 to 1, which is what draws an active icon solid', () => {
        const files = iconFontFiles();
        expect(files.length, 'nothing to read, so this assertion would pass vacuously').toBeGreaterThan(0);
        for (const file of files) {
            const fvar = tableOf(fs.readFileSync(path.join(repoRoot, file)), 'fvar');
            const axes = fvar === undefined ? [] : axesOf(fvar);
            const fill = axes.find((axis) => axis.tag === FILL_AXIS);
            expect(
                fill,
                file + ' exposes ' + axes.map((axis) => axis.tag).join(', ') + ' and no ' + FILL_AXIS + '. ' +
                'Subsetting the 3.97 MB font is a recorded deferred item; a subset that drops this axis silently ' +
                'un-fills nine call sites.'
            ).toBeDefined();
            expect(fill?.min, FILL_AXIS + ' does not start at 0 in ' + file).toBe(0);
            expect(fill?.max, FILL_AXIS + ' does not reach 1 in ' + file).toBe(1);
        }
    });
});

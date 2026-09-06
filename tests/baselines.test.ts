import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Why this file exists.
 *
 * baselines/v1.2.1/pixels/ and computed/ are the only record of what v1.2.1 looked like. Phase 8
 * (SPA-14) deletes src/pages/*.html once the parity checklist is ticked, and after that the app
 * cannot be re-rendered at all: re-capturing would mean reverting better-sqlite3 and reinstalling
 * the pinned installer. So a capture that was partial, or that photographed an unstyled frame, is
 * not a recoverable mistake - it is a baseline that quietly lies for the rest of the project.
 *
 * The failure this guards against is specifically the QUIET one. A capture that dies loudly gets
 * fixed on the spot. A capture that writes 19 of 20 files, or that raced the Tailwind Play CDN on
 * one page out of four, leaves artifacts that look entirely normal. In Phase 8 the first would
 * silently narrow the parity check rather than fail it, and the second would surface as a diff on
 * exactly one page - which reads like a rewrite regression on that page, the most expensive
 * possible way to discover a capture bug.
 *
 * Scope: presence, pairing, decodability, parseability and applied styling. This file compares NO
 * pixels. Pixel diffing is Phase 8's job and needs pixelmatch and pngjs; pulling those forward
 * would add supply-chain surface for no benefit here.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pixelsDir = path.join(repoRoot, 'baselines', 'v1.2.1', 'pixels');
const computedDir = path.join(repoRoot, 'baselines', 'v1.2.1', 'computed');
const manifestPath = path.join(repoRoot, 'baselines', 'v1.2.1', 'MANIFEST.md');

// The four pages v1.2.1 has and the five window sizes RESP-02 cares about.
const PAGES = ['index', 'companies', 'work-history', 'settings'];
const SIZES: ReadonlyArray<readonly [number, number]> = [
    [380, 600],
    [430, 932],
    [768, 1024],
    [1280, 800],
    [1920, 1080]
];

// The palette's background-dark, #101c22, as Chromium reports it. tools/baseline/capture.mjs waits
// on this exact computed value before every screenshot rather than on a load event, because the
// Play CDN is a JIT engine that generates CSS from the live DOM through a MutationObserver - `load`
// fires long before a page is styled. Asserting the same value here is what turns that wait from a
// hope into a checked property of the committed artifact.
const PALETTE_BACKGROUND = 'rgb(16, 28, 34)';

/*
 * Duplicated from COMPUTED_PROPS in tools/baseline/capture.mjs ON PURPOSE - importing it would make
 * this assertion tautological. The point is that the COMMITTED baselines carry this exact property
 * set: if someone widens or narrows the driver's list, the artifacts on disk become stale and the
 * Phase 8 diff would compare different properties on either side. Duplication makes that a test
 * failure that says "re-capture"; an import would make it silently pass.
 */
const COMPUTED_PROPS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'color',
    'background-color', 'border', 'border-radius', 'box-shadow', 'font-family', 'font-size',
    'font-weight', 'line-height', 'letter-spacing', 'flex', 'grid-template-columns', 'gap',
    'opacity', 'overflow', 'outline', 'z-index', 'transform'
];

/** Every `<page>@<width>x<height>` the capture is required to have produced. */
const EXPECTED_STEMS: string[] = PAGES.flatMap(
    (page) => SIZES.map(([width, height]) => `${page}@${width}x${height}`)
);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type StyleRecord = Record<string, Record<string, string>>;

function listDir(dir: string): string[] {
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function stemsOf(dir: string, extension: string): string[] {
    return listDir(dir)
        .filter((name) => name.endsWith(extension))
        .map((name) => name.slice(0, -extension.length))
        .sort();
}

function readRecord(stem: string): StyleRecord {
    const raw = fs.readFileSync(path.join(computedDir, `${stem}.json`), 'utf8');
    return JSON.parse(raw) as StyleRecord;
}

/*
 * The <body> element's key. tools/baseline/capture.mjs keys every record by a structural selector
 * path built from the element up to (but excluding) document.documentElement, so <body> is a
 * single top-level segment - `body:nth-child(2)` in practice, because <head> precedes it. Matched
 * by shape rather than by that literal string so a future <html> with a different child order
 * still resolves, while anything nested (which would contain ' > ') still cannot match.
 */
function bodyKey(record: StyleRecord): string | undefined {
    return Object.keys(record).find((key) => /^body(:nth-child\(\d+\))?$/.test(key));
}

describe('CUSTODY-10: the v1.2.1 baselines are complete and were captured styled', () => {
    it('pixels/ holds exactly 20 non-empty .png files and nothing else', () => {
        const entries = listDir(pixelsDir);
        expect(entries.filter((name) => !name.endsWith('.png'))).toEqual([]);
        expect(entries).toHaveLength(EXPECTED_STEMS.length);

        const empty = entries.filter((name) => fs.statSync(path.join(pixelsDir, name)).size === 0);
        expect(empty).toEqual([]);
    });

    it('computed/ holds exactly 20 non-empty .json files and nothing else', () => {
        const entries = listDir(computedDir);
        expect(entries.filter((name) => !name.endsWith('.json'))).toEqual([]);
        expect(entries).toHaveLength(EXPECTED_STEMS.length);

        const empty = entries.filter((name) => fs.statSync(path.join(computedDir, name)).size === 0);
        expect(empty).toEqual([]);
    });

    /*
     * Compared as SETS, not as counts. In Phase 8 this is the assertion that has to say WHICH page
     * at WHICH size is unaccounted for; "expected 20, got 19" would send someone diffing directory
     * listings by hand at exactly the moment the app can no longer be re-run.
     */
    it('the screenshot stems are exactly the 4 pages x 5 sizes cross product, by name', () => {
        const actual = stemsOf(pixelsDir, '.png');
        expect(actual.filter((stem) => !EXPECTED_STEMS.includes(stem))).toEqual([]);
        expect(EXPECTED_STEMS.filter((stem) => !actual.includes(stem))).toEqual([]);
    });

    it('every screenshot has a matching computed-style record, and every record a screenshot', () => {
        const pixels = stemsOf(pixelsDir, '.png');
        const computed = stemsOf(computedDir, '.json');
        expect(computed.filter((stem) => !pixels.includes(stem))).toEqual([]);
        expect(pixels.filter((stem) => !computed.includes(stem))).toEqual([]);
        expect(computed).toEqual(pixels);
    });

    /*
     * Not in the plan's behaviour list; added because a real defect made it necessary. The rule
     * `baselines/** text eol=lf` in .gitattributes is an explicit `text`, not `text=auto`, so it
     * forces end-of-line conversion with NO binary detection and overrides the `*.png binary` rule
     * earlier in that file - later rules win. Under it, git stripped the 0x0D of every CRLF pair
     * inside the PNG byte stream on commit (measured: a 16-byte probe stored as a 13-byte blob).
     * Every check above would still have passed: the files are present, paired and non-zero. Only
     * decoding catches it, and it would otherwise have surfaced in Phase 8.
     *
     * Checking the IHDR dimensions against the filename is the same assertion from the other side:
     * the driver waits for `window.innerWidth === <requested width>` before each shot precisely so
     * that an off-by-one content size cannot be filed under the wrong name.
     */
    it('every screenshot is a decodable PNG whose pixel dimensions match its filename', () => {
        const wrong: string[] = [];
        for (const stem of EXPECTED_STEMS) {
            const bytes = fs.readFileSync(path.join(pixelsDir, `${stem}.png`));
            const match = /@(\d+)x(\d+)$/.exec(stem);
            const width = Number(match?.[1]);
            const height = Number(match?.[2]);

            if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
                wrong.push(`${stem}: not a PNG - signature is ${bytes.subarray(0, 8).toString('hex')}`);
                continue;
            }
            if (bytes.subarray(bytes.length - 8, bytes.length - 4).toString('ascii') !== 'IEND') {
                wrong.push(`${stem}: truncated - no IEND chunk`);
                continue;
            }
            const actual = `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
            if (actual !== `${width}x${height}`) {
                wrong.push(`${stem}: IHDR says ${actual}, filename says ${width}x${height}`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it('every computed-style record parses as JSON and yields a non-empty object', () => {
        const bad: string[] = [];
        for (const stem of EXPECTED_STEMS) {
            let record: StyleRecord;
            try {
                record = readRecord(stem);
            } catch (error) {
                bad.push(`${stem}: ${(error as Error).message}`);
                continue;
            }
            if (record === null || typeof record !== 'object' || Array.isArray(record)) {
                bad.push(`${stem}: not a JSON object`);
                continue;
            }
            if (Object.keys(record).length === 0) {
                bad.push(`${stem}: empty object - the capture wrote a file it never populated`);
            }
        }
        expect(bad).toEqual([]);
    });

    /*
     * On ALL 20 records, never on a sample. A capture that raced the runtime-generated CSS on one
     * page out of four would pass a sampled check, and the resulting Phase 8 diff would look like a
     * rewrite regression confined to that page.
     */
    it(`every record has the body element at ${PALETTE_BACKGROUND}, so no frame was captured unstyled`, () => {
        const unstyled: string[] = [];
        for (const stem of EXPECTED_STEMS) {
            const record = readRecord(stem);
            const key = bodyKey(record);
            if (key === undefined) {
                unstyled.push(`${stem}: no body element recorded`);
                continue;
            }
            const background = record[key]?.['background-color'];
            if (background !== PALETTE_BACKGROUND) {
                unstyled.push(`${stem}: body background is ${String(background)}, expected ${PALETTE_BACKGROUND}`);
            }
        }
        expect(unstyled).toEqual([]);
    });

    it('every element in every record carries exactly the enumerated property set', () => {
        const drifted: string[] = [];
        const expected = [...COMPUTED_PROPS].sort();
        for (const stem of EXPECTED_STEMS) {
            const record = readRecord(stem);
            for (const [selector, properties] of Object.entries(record)) {
                const actual = Object.keys(properties).sort();
                if (actual.length !== expected.length || actual.some((prop, i) => prop !== expected[i])) {
                    const missing = expected.filter((prop) => !actual.includes(prop));
                    const extra = actual.filter((prop) => !expected.includes(prop));
                    drifted.push(
                        `${stem} :: ${selector || '<html>'}: ` +
                        `missing [${missing.join(', ')}], extra [${extra.join(', ')}]`
                    );
                }
            }
            if (drifted.length > 0) break;
        }
        expect(drifted).toEqual([]);
    });

    /*
     * The manifest is what a Phase 8 re-capture is reconstructed from. A capture taken by a
     * different playwright-core is not comparable to this one - Playwright's Electron support is
     * experimental and sits outside its stability guarantees - so the version has to be recorded,
     * not merely pinned in package.json where a dependency bump would erase the evidence.
     */
    it('MANIFEST.md records every matrix size and the playwright-core version used', () => {
        const manifest = fs.readFileSync(manifestPath, 'utf8');

        const missing = SIZES
            .map(([width, height]) => `${width}x${height}`)
            .filter((size) => !manifest.includes(size));
        expect(missing).toEqual([]);

        const pkg = JSON.parse(
            fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
        ) as { devDependencies: Record<string, string> };
        const pinned = pkg.devDependencies['playwright-core'];
        expect(pinned).toBe('1.63.0');
        expect(manifest).toContain(pinned);
    });
});

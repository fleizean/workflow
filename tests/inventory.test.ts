import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Why these numbers are load-bearing.
 *
 * Phase 8 (SPA-14) deletes src/pages/*.html once the behaviour parity checklist in
 * baselines/v1.2.1/PARITY-CHECKLIST.md is fully ticked. That is a one-way door: after the
 * deletion, the record of what those 2,750 lines of inline script did is git archaeology.
 *
 * The checklist is only trustworthy if the artifacts it cites still describe the tree. This
 * file is what makes that true. It recomputes every count from the LIVE source with the same
 * regular expressions tools/baseline/inventory.sh uses, and compares the COMMITTED artifacts
 * against them element-wise. A source change that is not regenerated therefore fails CI,
 * rather than leaving a stale file that still looks authoritative (threat T-01-11).
 *
 * The semantics are duplicated here in TypeScript rather than shelled out to the generator on
 * purpose: the suite must behave identically on Windows and on the Ubuntu CI runner, and a
 * child process running grep is not available on both.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Re-verified against this repository at commit 22fe9a0. Each number is the denominator some
// later phase divides by, so a silent drift here understates a workload rather than failing.
const EXPECTED_HANDLER_SITES = 106;
const EXPECTED_API_NAMES = 21;
const EXPECTED_API_CALL_SITES = 67;

// 25, NOT 24. .planning/research/PITFALLS.md states 24; the live count is 25 and the correction
// is recorded in PARITY-CHECKLIST.md. Phase 6 (IPC-01) reproduces this surface and Phase 8
// (REL-06) ticks against it, so 24 would understate the parity workload by one whole API.
// If this assertion ever fails after a Phase 8 change, regenerate the artifact AND update the
// checklist together. Do not relax the number to make the suite green.
const EXPECTED_PRELOAD_APIS = 25;
const EXPECTED_IPC_CHANNELS = 25;

// Exposed by preload.js, referenced nowhere under src/. SPA-15 removes these rather than
// porting them. Asserted as a SET, not a count, so swapping one dead API for another is caught.
const EXPECTED_DEAD_APIS = [
    'getSessionsByDateCompany',
    'getSessionsGrouped',
    'getTodaySessions',
    'getTodaysSessionsSummary',
    'updateCompanyExcelConfig'
];

// Finding B4. The UI calls window.api.saveSetting; the bridge exposes setSetting. This is a
// live defect, not dead code: both call sites persist pomodoro_enabled and neither write lands.
const EXPECTED_UNEXPOSED_CALL = 'saveSetting';

const WINDOW_API_PREFIX = 'window.api.';

// Mirrors of the generator's greps.
//   grep -o "addEventListener"
//   grep -o "window\.api\.[A-Za-z0-9_]*"
//   grep -o "^    [a-zA-Z0-9_]*:" preload.js
//   grep -o "ipcMain\.\(handle\|on\)('[^']*'" main.js
const HANDLER_RE = /addEventListener/g;
const WINDOW_API_RE = /window\.api\.[A-Za-z0-9_]*/g;
const PRELOAD_PROPERTY_RE = /^ {4}[A-Za-z0-9_]*:/gm;
const IPC_CHANNEL_RE = /ipcMain\.(?:handle|on)\('([^']*)'/g;

// grep -r --include=*.html --include=*.js src/
const collectSources = (dir: string): string[] => {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...collectSources(full));
        } else if (entry.isFile() && (entry.name.endsWith('.html') || entry.name.endsWith('.js'))) {
            found.push(full);
        }
    }
    return found.sort();
};

const readRepoFile = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// The committed artifacts are LF in the index; .gitattributes pins baselines/** to eol=lf, but
// tolerate CRLF anyway so a checkout with different settings cannot produce a phantom failure.
const readArtifactLines = (rel: string): string[] =>
    readRepoFile(rel).split(/\r?\n/).filter((line) => line !== '');

const rendererFiles = collectSources(path.join(repoRoot, 'src'));
const rendererText = rendererFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const preloadSource = readRepoFile('preload.js');
const mainSource = readRepoFile('main.js');

const countMatches = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

// LC_ALL=C sort is byte order; for ASCII that is exactly JS's default code-unit sort.
const sortBytewise = (values: string[]): string[] => [...values].sort();

const calledApiNames: string[] = (rendererText.match(WINDOW_API_RE) ?? [])
    .map((match) => match.slice(WINDOW_API_PREFIX.length));

const exposedApiNames: string[] = sortBytewise(
    (preloadSource.match(PRELOAD_PROPERTY_RE) ?? []).map((match) => match.trim().replace(/:$/, ''))
);

const ipcChannelNames: string[] = sortBytewise(
    [...mainSource.matchAll(IPC_CHANNEL_RE)].map((match) => match[1] ?? '')
);

describe('CUSTODY-09: the v1.2.1 behavior inventory is complete and regenerable', () => {
    it(`registers exactly ${EXPECTED_HANDLER_SITES} addEventListener sites under src/`, () => {
        expect(countMatches(rendererText, HANDLER_RE)).toBe(EXPECTED_HANDLER_SITES);
    });

    it(`calls exactly ${EXPECTED_API_NAMES} distinct window.api names`, () => {
        expect(new Set(calledApiNames).size).toBe(EXPECTED_API_NAMES);
    });

    it(`calls window.api from exactly ${EXPECTED_API_CALL_SITES} sites`, () => {
        expect(calledApiNames.length).toBe(EXPECTED_API_CALL_SITES);
    });

    it(`exposes exactly ${EXPECTED_PRELOAD_APIS} APIs from preload.js — the corrected figure, not 24`, () => {
        expect(exposedApiNames.length).toBe(EXPECTED_PRELOAD_APIS);
    });

    it(`answers on exactly ${EXPECTED_IPC_CHANNELS} ipcMain channels in main.js`, () => {
        expect(ipcChannelNames.length).toBe(EXPECTED_IPC_CHANNELS);
    });

    it('preload-surface.txt still matches preload.js exactly, in order', () => {
        // Order matters as well as membership: the artifact is sorted, so an order difference
        // means the extraction changed shape and the Phase 8 diff would be unreadable.
        expect(readArtifactLines('baselines/v1.2.1/preload-surface.txt')).toEqual(exposedApiNames);
    });

    it('ipc-channels.txt still matches main.js exactly, in order', () => {
        expect(readArtifactLines('baselines/v1.2.1/ipc-channels.txt')).toEqual(ipcChannelNames);
    });

    it('handlers.tsv and api-calls.tsv still have one row per live site', () => {
        // The two TSVs are too large to compare element-wise usefully, but a row count that
        // disagrees with the live tree is the same staleness signal.
        expect(readArtifactLines('baselines/v1.2.1/handlers.tsv').length)
            .toBe(EXPECTED_HANDLER_SITES);
        expect(readArtifactLines('baselines/v1.2.1/api-calls.tsv').length)
            .toBe(EXPECTED_API_CALL_SITES);
    });

    it('has exactly five exposed-but-never-called preload APIs, and they are the named five', () => {
        const called = new Set(calledApiNames);
        const dead = exposedApiNames.filter((name) => !called.has(name));
        expect(dead).toEqual(EXPECTED_DEAD_APIS);
    });

    it(`has exactly one called-but-never-exposed name, and it is ${EXPECTED_UNEXPOSED_CALL} (B4)`, () => {
        const exposed = new Set(exposedApiNames);
        const unexposed = sortBytewise([...new Set(calledApiNames)].filter((n) => !exposed.has(n)));
        expect(unexposed).toEqual([EXPECTED_UNEXPOSED_CALL]);
    });

    it('reads no database and no user content', () => {
        // The inventory is derived from source text only, which is what makes it safe to run
        // before the better-sqlite3 barrier (plan 01-07) and safe to commit to a public repo.
        expect(rendererFiles.every((f) => f.endsWith('.html') || f.endsWith('.js'))).toBe(true);
        expect(rendererFiles.some((f) => f.endsWith('.db'))).toBe(false);
    });
});

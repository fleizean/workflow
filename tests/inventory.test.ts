import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_TREE, listV121, readV121 } from './helpers/v121-source';
import { execFileSync } from 'node:child_process';
import { read } from './helpers/ts-imports';

/*
 * Why these numbers are load-bearing.
 *
 * Phase 8 (SPA-14) deletes legacy/pages/*.html once the behaviour parity checklist in
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

// Re-verified against this repository at commit 22fe9a0, and again after Phase 7 moved the v1.2.1 renderer
// from src/ to legacy/: the counts are unchanged, because the four page fragments deleted in the same change
// held no addEventListener and no window.api call at all. Each number is the denominator some
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

// Exposed by preload.js, referenced nowhere in the v1.2.1 renderer. SPA-15 removes these rather than
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

// Where Phase 7 put the v1.2.1 renderer. The inventory records what v1.2.1 did, so it follows that code rather
// than staying pointed at src/, which now holds the v2 tree.

// Mirrors of the generator's greps.
//   grep -o "addEventListener"
//   grep -o "window\.api\.[A-Za-z0-9_]*"
//   grep -o "^    [a-zA-Z0-9_]*:" preload.js
//   grep -o "ipcMain\.\(handle\|on\)('[^']*'" main.js
const HANDLER_RE = /addEventListener/g;
const WINDOW_API_RE = /window\.api\.[A-Za-z0-9_]*/g;
const PRELOAD_PROPERTY_RE = /^ {4}[A-Za-z0-9_]*:/gm;
const IPC_CHANNEL_RE = /ipcMain\.(?:handle|on)\('([^']*)'/g;

/*
 * grep -r --include=*.html --include=*.js legacy/ - over the v1.2.1 renderer WHEREVER IT LIVES.
 *
 * SPA-14 deleted it in 08-F. Repointing this file at baselines/v1.2.1/*.tsv would have destroyed the
 * whole point of it: those artifacts are what the counts are compared AGAINST, and a test that reads
 * the artifact and compares it with the artifact proves nothing at all. listV121/readV121 take the
 * bytes out of the commit that last carried them instead, so every count below is still RECOMPUTED
 * from the v1.2.1 source and still diffed against the committed artifact - which is exactly what makes
 * a stale artifact impossible to mistake for an authoritative one.
 */
const collectSources = (dir: string): string[] =>
    listV121(dir).filter((file) => file.endsWith('.html') || file.endsWith('.js'));

const readRepoFile = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// The committed artifacts are LF in the index; .gitattributes pins baselines/** to eol=lf, but
// tolerate CRLF anyway so a checkout with different settings cannot produce a phantom failure.
const readArtifactLines = (rel: string): string[] =>
    readRepoFile(rel).split(/\r?\n/).filter((line) => line !== '');

const rendererFiles = collectSources(LEGACY_TREE);
const rendererText = rendererFiles.map((file) => readV121(file)).join(String.fromCharCode(10));
const preloadSource = readV121('preload.js');
const mainSource = readV121('main.js');

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
    it(`registers exactly ${EXPECTED_HANDLER_SITES} addEventListener sites under legacy/`, () => {
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

/*
 * 08-REVIEW-TIMER WR-09. The generator behind four artifacts whose whole purpose is to be authoritative about a
 * tree nobody can open any more could produce them empty: `set -e` does not fail a pipeline on a non-zero LEFT
 * side without `set -o pipefail`, so a `git archive` that failed - a partial clone, a bad SHA, an unreadable
 * object - left `tar` succeeding on empty input, $SCAN an empty directory, and handlers.tsv, api-calls.tsv,
 * preload-surface.txt and ipc-channels.txt regenerated as empty files.
 *
 * The assertions above would catch the committed result, so this is a fragility rather than a hole - but a
 * generator should not be able to produce a silently empty artifact at all.
 */
describe('WR-09: the inventory generator cannot regenerate an empty artifact', () => {
    const script = read('tools/baseline/inventory.sh');

    it('fails the pipeline when git archive does, rather than tarring nothing', () => {
        expect(script).toContain('set -euo pipefail');
        expect(script, 'set -e alone lets a failed left-hand side through').not.toMatch(/^set -eu$/m);
    });

    it('checks the v1.2.1 source really materialised before it scans', () => {
        expect(script).toContain('did not materialise');
        for (const marker of ['/legacy', 'main.js', 'preload.js']) {
            expect(script).toContain(marker);
        }
    });

    it('is a real difference, not a spelling: the control shows what set -eu alone lets through', () => {
        const run = (flags: string): number => {
            try {
                execFileSync('bash', [flags, '-c', 'false | true'], { stdio: 'ignore' });
                return 0;
            } catch (error) {
                return (error as { status?: number }).status ?? -1;
            }
        };
        expect(run('-eu'), 'set -eu already failed a pipeline, so pipefail changes nothing').toBe(0);
        expect(run('-euo')).not.toBe(0);
    });

    it('cleans up with a trap that cannot itself change the exit status', () => {
        // `trap '[ -n "$TMP" ] && rm -rf "$TMP"' EXIT` returns non-zero when TMP is empty, which under set -e
        // can alter what the script reports.
        expect(script).not.toContain('[ -n "$TMP" ] && rm -rf');
        expect(script).toContain('trap \'rm -rf "${TMP:-}"\' EXIT');
    });
});

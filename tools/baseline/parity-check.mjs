#!/usr/bin/env node
/*
 * Criterion 2's second gate, as something that runs.
 *
 *   npm run parity:check
 *
 * 08-REVIEW-TIMER WR-07 / 08-REVIEW-SCREENS WR-05: capture-v2.mjs and diff-computed.mjs were referenced by no
 * package.json script, no test and no workflow. diff-computed's own header argued that its SETTLED register is
 * "a gate rather than a reading: a future change either matches the baselines or arrives in the unexplained
 * list", and VISUAL-PARITY-DIFF.md said it "exits non-zero on any difference that is not in its register with a
 * reason" - but a gate nothing invokes cannot exit non-zero at anybody, and the committed 29-difference register
 * could not go stale in a way any check would notice.
 *
 * This is the invocation. It captures the packaged v2 build, diffs it against the Phase 1 baselines, and fails on
 * two things:
 *
 *   1. any design-property difference that is NOT in the register with a reason;
 *   2. a committed VISUAL-PARITY-DIFF.md that is not what this run produces - the staleness guard, which is what
 *      tests/inventory.test.ts exists to provide for the behaviour inventory.
 *
 * It needs a packaged build (capture-v2 launches the unpacked app), so `npm run build:unpack` comes first. With
 * --write it updates the committed report instead of failing on it, which is how a deliberate change is recorded.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCaptureV2 } from './capture-v2.mjs';
import { renderReport, run } from './diff-computed.mjs';

const SCRIPT_NAME = 'tools/baseline/parity-check.mjs';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPORT = path.join(repoRoot, 'baselines', 'v1.2.1', 'VISUAL-PARITY-DIFF.md');

const write = process.argv.slice(2).includes('--write');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-parity-'));
let captured;

try {
    captured = await runCaptureV2({ out });
} catch (error) {
    console.error(SCRIPT_NAME + ': the capture failed - ' + (error.stack ?? error.message));
    console.error(SCRIPT_NAME + ': run `npm run build:unpack` first; this gate photographs the packaged app.');
    process.exit(1);
}

if (captured.remote.length > 0) {
    console.error(SCRIPT_NAME + ': the app attempted ' + String(captured.remote.length) + ' remote request(s)');
    process.exit(1);
}

const result = run({ v2Dir: path.join(out, 'computed') });
const unexplained = Object.values(result.design).flatMap((page) => page.unexplained);
const report = renderReport(result);

// CRLF in the worktree (.gitattributes, D-13); the generator emits LF. Compare the text, not the line endings.
const normalise = (text) => text.replace(/\r\n/g, '\n');
const committed = fs.existsSync(REPORT) ? normalise(fs.readFileSync(REPORT, 'utf8')) : '';
const fresh = normalise(report);

if (write) {
    fs.writeFileSync(REPORT, report, 'utf8');
    console.log(SCRIPT_NAME + ': wrote ' + path.relative(repoRoot, REPORT));
}

fs.rmSync(out, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
fs.rmSync(captured.fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

let failed = false;

if (unexplained.length > 0) {
    failed = true;
    console.error(SCRIPT_NAME + ': ' + String(unexplained.length) + ' design-property difference(s) with no reason:');
    for (const difference of unexplained.slice(0, 20)) {
        console.error(SCRIPT_NAME + ':   ' + difference.page + ' ' + difference.prop + ' ' + difference.side +
            ' ' + difference.value);
    }
}

if (!write && committed !== fresh) {
    failed = true;
    console.error(SCRIPT_NAME + ': baselines/v1.2.1/VISUAL-PARITY-DIFF.md is not what this run produces.');
    console.error(SCRIPT_NAME + ': re-run with --write once the difference is understood and explained.');
}

if (failed) {
    process.exit(1);
}

const settled = Object.values(result.design).reduce((total, page) => total + page.settled.length, 0);
console.log(SCRIPT_NAME + ': OK - ' + String(settled) + ' settled, 0 unexplained, the report matches.');
process.exit(0);

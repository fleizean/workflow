/*
 * Reading a v1.2.1 file after SPA-14 deleted it.
 *
 * Five guards pinned `main.js`, `preload.js`, `database/db.js` and `legacy/**` by path, and four of
 * them protect the Core Value: the SQL transcription the migrations are checked against, the
 * behaviour inventory that authorises the deletion, the IPC parity map, and the setting defaults a
 * drift in which would change a user's daily target. Repointing those at a summary artifact would
 * have kept the names and lost the checking - the artifacts are what the guards compare AGAINST, so
 * a guard that reads the artifact and compares it with the artifact proves nothing.
 *
 * Git already holds the files, and `tests/db-legacy-shapes.test.ts` has read `database/db.js` out of
 * history since Phase 4 (`git cat-file blob <commit>:database/db.js`) to replay every historical
 * shape. So the guards keep their exact strength and only change where they read from. `verify.yml`
 * checks out with `fetch-depth: 0`, which is what makes that available in CI.
 *
 * On a shallow clone there is no history to read and no file on disk. `available()` says so and the
 * callers skip rather than pass: a guard that cannot look must not report green.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoRoot } from './ts-imports';

/** Paths SPA-14 deleted. Named so a reader of any guard can see the whole set at once. */
export const DELETED_V121_PATHS = ['main.js', 'preload.js', 'database/db.js'] as const;

/** Where the v1.2.1 renderer lived between the Phase 7 move and the SPA-14 deletion. */
export const LEGACY_TREE = 'legacy';

const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const gitBuffer = (args: string[]): Buffer =>
    execFileSync('git', args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });

/** False on a shallow clone, where neither the worktree nor the history can answer. */
export function historyAvailable(): boolean {
    try {
        return git(['rev-parse', '--is-shallow-repository']).trim() === 'false';
    } catch {
        return false;
    }
}

/*
 * The newest commit whose tree carries the path. `--diff-filter=d` drops the deletion itself, so
 * this is the last commit that had content there - the same form the Phase 4 history walk uses.
 */
const lastCommitWith = (rel: string): string => {
    const sha = git(['log', '--format=%H', '--diff-filter=d', '-1', '--', rel]).trim();
    if (sha === '') throw new Error('git knows no commit carrying ' + rel);
    return sha;
};

const commitCache = new Map<string, string>();
const commitFor = (rel: string): string => {
    const cached = commitCache.get(rel);
    if (cached !== undefined) return cached;
    const sha = lastCommitWith(rel);
    commitCache.set(rel, sha);
    return sha;
};

/**
 * A v1.2.1 file's bytes: from the worktree while it is still there, otherwise from the last commit
 * that carried it. The fallback is what keeps every pin working across the SPA-14 deletion, and
 * having both means this helper needs no flag day.
 */
export function readV121(rel: string): string {
    const onDisk = path.join(repoRoot, rel);
    if (fs.existsSync(onDisk)) return fs.readFileSync(onDisk, 'utf8');
    return gitBuffer(['cat-file', 'blob', commitFor(rel) + ':' + rel]).toString('utf8');
}

/** Every path under a v1.2.1 directory, repo-relative with forward slashes, sorted. */
export function listV121(dir: string): string[] {
    const onDisk = path.join(repoRoot, dir);
    if (fs.existsSync(onDisk)) {
        const out: string[] = [];
        const walk = (absolute: string): void => {
            for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
                const child = path.join(absolute, entry.name);
                if (entry.isDirectory()) walk(child);
                else out.push(path.relative(repoRoot, child).split(path.sep).join('/'));
            }
        };
        walk(onDisk);
        return out;
    }
    return git(['ls-tree', '-r', '--name-only', commitFor(dir), '--', dir])
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .sort();
}

/** The commit each deleted path is being read out of, for a guard that wants to say so. */
export function sourceCommit(rel: string): string | null {
    return fs.existsSync(path.join(repoRoot, rel)) ? null : commitFor(rel);
}

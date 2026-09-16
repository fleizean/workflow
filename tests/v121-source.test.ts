/*
 * What the five v1.2.1 guards actually read.
 *
 * 08-REVIEW-TIMER WR-08. Before SPA-14, `main.js`, `preload.js` and `database/db.js` were tracked, so git enforced
 * the bytes the SQL transcription, the behaviour inventory, the IPC parity map, the Sheets retirement scan and the
 * setting defaults were checked against. `84a9234` deleted them and left readV121 trying the worktree first - so
 * any file that appeared at one of those paths silently became the v1.2.1 source of truth for all five. The
 * reviewer reproduced it with a two-line main.js at the repo root:
 *
 *     x answers on exactly 25 ipcMain channels in main.js   expected +0 to be 25
 *     x ipc-channels.txt still matches main.js exactly      expected [ 'close-window', ... ] to deeply equal []
 *
 * The failure is loud, which is the good case. But the INPUT to a guard was no longer pinned by anything, and the
 * commit message's claim that "every guard reads the same bytes it read before" was true only while nobody created
 * a file there. Git is the pin now, unconditionally.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    DELETED_V121_PATHS, LEGACY_TREE, historyAvailable, listV121, readV121, sourceCommit
} from './helpers/v121-source';
import { repoRoot } from './helpers/ts-imports';

const STRAY = path.join(repoRoot, 'main.js');
const STRAY_BODY = '// not the v1.2.1 main process\nmodule.exports = {};\n';
let planted = false;

afterEach(() => {
    if (planted) {
        fs.rmSync(STRAY, { force: true });
        planted = false;
    }
});

describe('WR-08: a v1.2.1 file is read from git, not from whatever is on disk', () => {
    it.runIf(historyAvailable())('reads the pinned blob even with a stray file at the same path', () => {
        const pinned = readV121('main.js');
        expect(pinned, 'the pinned blob does not look like v1.2.1 main process').toContain('ipcMain');

        expect(fs.existsSync(STRAY), 'main.js is back in the worktree - SPA-14 deleted it').toBe(false);
        fs.writeFileSync(STRAY, STRAY_BODY, 'utf8');
        planted = true;

        expect(readV121('main.js'), 'a stray file replaced the pinned v1.2.1 source for five guards')
            .toBe(pinned);
        expect(readV121('main.js')).not.toContain('not the v1.2.1 main process');
    });

    it.runIf(historyAvailable())('names the commit it read from, for every deleted path', () => {
        for (const rel of [...DELETED_V121_PATHS, LEGACY_TREE]) {
            const commit = sourceCommit(rel);
            expect(commit, 'no commit was named for ' + rel).toMatch(/^[0-9a-f]{40}$/);
        }
    });

    it.runIf(historyAvailable())('lists the legacy tree from git as well', () => {
        const files = listV121(LEGACY_TREE);
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            expect(file.startsWith(LEGACY_TREE + '/')).toBe(true);
        }
    });

    it('consults no filesystem path for a v1.2.1 file', () => {
        const source = fs.readFileSync(path.join(repoRoot, 'tests', 'helpers', 'v121-source.ts'), 'utf8');
        expect(source, 'the worktree is tried first again').not.toContain('if (fs.existsSync(onDisk))');
    });
});

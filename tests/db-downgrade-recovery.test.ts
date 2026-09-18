/*
 * DATA CR-02: the README's downgrade instruction, executed rather than read.
 *
 * v1.2.1 only knows the name krono.db, so after v2 has adopted the database a downgraded install finds nothing and
 * creates a new, empty one - and if it is then killed from the tray, which is the state the whole of adopt.ts
 * exists for, it leaves krono.db-wal and krono.db-shm behind. Nothing binds a -wal to a particular database file,
 * so renaming workflow.db onto krono.db with those sidecars still there makes the EMPTY database's frames the
 * restored database's frames: SQLite replays them and the user is left with an empty app, integrity_check ok.
 *
 * The instruction is a set of file operations, so it is testable as one. RECOVERY is executed against a fixture in
 * that exact state, the old instruction beside it as the negative control, and the last test holds README.md to
 * the steps that were run - a documented recovery nobody has performed is a guess.
 */

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { cleanupFixtures, copyFixture, makeCleanFixture, makeStaleWalFixture } from './fixtures/seed';
import { read } from './helpers/ts-imports';

const HISTORY_ROWS = 500;
const LEGACY = 'krono.db';
const TARGET = 'workflow.db';

/*
 * The corrected instruction, as operations. Order is the whole of it: every sidecar v1.2.1 left must be gone
 * BEFORE the rename, because a -wal that outlives the file it was written for is applied to whatever takes that
 * file's name next.
 */
const RECOVERY = {
    delete: [LEGACY, LEGACY + '-wal', LEGACY + '-shm'],
    rename: [[TARGET, LEGACY], [TARGET + '-wal', LEGACY + '-wal'], [TARGET + '-shm', LEGACY + '-shm']]
} as const;

/** What the README said before this change: the empty database goes, its sidecars do not. */
const OLD_INSTRUCTION = { delete: [LEGACY], rename: [[TARGET, LEGACY]] } as const;

interface Instruction {
    readonly delete: readonly string[];
    readonly rename: readonly (readonly string[])[];
}

function follow(dir: string, instruction: Instruction): void {
    for (const name of instruction.delete) {
        fs.rmSync(path.join(dir, name), { force: true });
    }
    for (const [from, to] of instruction.rename) {
        const source = path.join(dir, from ?? '');
        if (!fs.existsSync(source)) continue;
        // eslint-disable-next-line no-restricted-syntax -- the user's own rename, performed (CUSTODY-03)
        fs.renameSync(source, path.join(dir, to ?? ''));
    }
}

interface Reading {
    readonly sessions: number;
    readonly integrity: string;
}

function readBack(dbPath: string): Reading {
    const db = new Database(dbPath, { fileMustExist: true, readonly: true });
    try {
        return {
            sessions: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM work_sessions').get()?.n ?? -1,
            integrity: String(db.pragma('integrity_check', { simple: true }))
        };
    } finally {
        db.close();
    }
}

/*
 * A directory in the exact state a downgraded user is in: the real database under the new name, in WAL mode as the
 * app leaves it, and beside it the empty database v1.2.1 made, with the sidecars its kill left behind.
 */
async function downgradedProfile(): Promise<{ dir: string; sessions: number }> {
    const dir = path.dirname(copyFixture(makeCleanFixture()));
    for (const name of fs.readdirSync(dir)) {
        // eslint-disable-next-line no-restricted-syntax -- test setup: the adoption v2 already performed
        fs.renameSync(path.join(dir, name), path.join(dir, name.replace(LEGACY, TARGET)));
    }
    const live = new Database(path.join(dir, TARGET));
    // The app's own journal mode, so the restored file is one SQLite will replay a -wal onto.
    live.pragma('journal_mode = WAL');
    // Enough history that the loss below cannot be read as rounding, and checkpointed in so the file holds it.
    const insert = live.prepare(
        'INSERT INTO work_sessions (name, duration, date, company_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    live.transaction(() => {
        for (let i = 0; i < HISTORY_ROWS; i++) {
            insert.run('history-' + String(i), 1800, '2026-03-01', 1, null, '2026-03-01 09:00:00');
        }
    })();
    live.pragma('wal_checkpoint(TRUNCATE)');
    const sessions = live.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM work_sessions').get()?.n ?? -1;
    live.close();

    await makeStaleWalFixture(path.join(dir, LEGACY));
    return { dir, sessions };
}

afterAll(cleanupFixtures);

describe('DATA CR-02: the documented way back to v1.2.1 is safe when followed exactly', () => {
    it('reaches the state the instruction is written for', async () => {
        const { dir, sessions } = await downgradedProfile();
        expect(sessions, 'the fixture holds no sessions, so nothing below could be lost')
            .toBeGreaterThan(HISTORY_ROWS);
        expect(
            fs.statSync(path.join(dir, LEGACY + '-wal')).size,
            'the empty database left no -wal, so the hazard this test is about is not present'
        ).toBeGreaterThan(0);
        expect(readBack(path.join(dir, LEGACY)).sessions, 'the database v1.2.1 made is not empty').toBe(0);
    });

    it('loses everything when the sidecars are left behind (the old instruction, performed)', async () => {
        const { dir, sessions } = await downgradedProfile();

        follow(dir, OLD_INSTRUCTION);

        const after = readBack(path.join(dir, LEGACY));
        expect(after.integrity, 'the loss is silent - that is what makes it dangerous').toBe('ok');
        expect(sessions, 'nothing was there to lose').toBeGreaterThan(HISTORY_ROWS);
        expect(
            after.sessions,
            'the empty database\'s -wal did not replay, so this control no longer controls: either SQLite\'s ' +
            'behaviour changed or the fixture stopped reproducing the hazard'
        ).toBe(0);
    });

    it('restores every session when the instruction is followed as written', async () => {
        const { dir, sessions } = await downgradedProfile();

        follow(dir, RECOVERY);

        const after = readBack(path.join(dir, LEGACY));
        expect(after.sessions, 'following the shipped instruction exactly still lost sessions').toBe(sessions);
        expect(after.integrity).toBe('ok');
        expect(fs.existsSync(path.join(dir, TARGET)), 'the new name was left behind beside the old one').toBe(false);
    });

    it('is the instruction README.md actually gives', () => {
        const readme = read('README.md');
        const bullet = /\*\*Going back to v1\.2\.1[\s\S]*?(?=\n\n|\n## )/.exec(readme)?.[0] ?? '';
        expect(bullet, 'the downgrade bullet is gone from README.md, so this test guards nothing').not.toBe('');

        for (const name of [...RECOVERY.delete, ...RECOVERY.rename.map(([from]) => String(from))]) {
            expect(bullet, 'the instruction does not name ' + name).toContain(name);
        }
        expect(
            bullet.indexOf(LEGACY + '-shm') < bullet.indexOf('Rename'),
            'the rename is described before the sidecars are dealt with, which is the order that loses the data'
        ).toBe(true);
    });
});

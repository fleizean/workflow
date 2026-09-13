/*
 * V2-SCHEMA-02: v1.2.1's krono.db becomes v2's workflow.db, moved by the app rather than by the user.
 *
 * The whole risk is the -wal. The app runs in WAL mode (client.ts:9), so committed frames can live in
 * krono.db-wal and nowhere else - the state every user who was killed from the tray is in. SQLite will not look
 * for krono.db-wal beside workflow.db, so renaming the database alone destroys those transactions silently: the
 * app opens, the schema is there, and the last session is gone with no error anywhere. The first test below is
 * written against that failure, and the second one performs it deliberately so the first cannot pass vacuously.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { adoptLegacyDatabase } from '../src/lib/db/adopt';
import { assertWalNonEmpty, cleanupFixtures, copyFixture, makeCleanFixture, makeWalFixture } from './fixtures/seed';

const TABLES = ['companies', 'work_sessions', 'settings', 'pomodoro_sessions'] as const;

/*
 * seed-child.cjs's split, restated rather than imported: a test that imported the numbers could only prove the
 * generator agrees with itself. 5 rows of 3600 s are checkpointed into the main file; 40 rows of 100 s are
 * committed afterwards and never checkpointed, so they exist only in the sidecar.
 */
const CHECKPOINTED_ROWS = 5;
const WAL_ONLY_ROWS = 40;
const ALL_ROWS = CHECKPOINTED_ROWS + WAL_ONLY_ROWS;
const ALL_SECONDS = CHECKPOINTED_ROWS * 3600 + WAL_ONLY_ROWS * 100;

const tempDirs: string[] = [];

function tempDir(tag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wft-adopt-' + tag + '-'));
    tempDirs.push(dir);
    return dir;
}

afterAll(() => {
    cleanupFixtures();
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

interface Content {
    readonly integrity: string;
    readonly sessions: number;
    readonly totalDuration: number;
    readonly digest: string;
}

// Every row of every v1.2.1 table, in rowid order, through the driver. Read AFTER any directory assertion: a
// read-only connection on a WAL database leaves a -shm and an empty -wal of its own behind.
function readContent(dbPath: string): Content {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const hash = createHash('sha256');
        for (const table of TABLES) {
            hash.update(table);
            // Every name is a module constant, never caller input (T-01-35).
            for (const row of db.prepare<[], Record<string, unknown>>(
                'SELECT * FROM "' + table + '" ORDER BY rowid'
            ).iterate()) {
                hash.update(JSON.stringify(row));
            }
        }
        return {
            integrity: String(db.pragma('integrity_check', { simple: true })),
            sessions: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM work_sessions').get()?.n ?? -1,
            totalDuration: db.prepare<[], { n: number }>(
                'SELECT COALESCE(SUM(duration), 0) AS n FROM work_sessions'
            ).get()?.n ?? -1,
            digest: hash.digest('hex')
        };
    } finally {
        db.close();
    }
}

const entriesIn = (dbPath: string): string[] => fs.readdirSync(path.dirname(dbPath)).sort();

/** A private copy of the whole triple, and the two paths the adoption works between. */
function walCase(fixture: string): { legacy: string; target: string } {
    const legacy = copyFixture(fixture);
    assertWalNonEmpty(legacy);
    return { legacy, target: path.join(path.dirname(legacy), 'workflow.db') };
}

describe('V2-SCHEMA-02: the -wal is folded in before the move', () => {
    it('carries rows that live only in the -wal across the move', async () => {
        const { legacy, target } = walCase(await makeWalFixture());

        const before = readContent(legacy);
        expect(before.sessions, 'the fixture must hold rows in both places for this to prove anything')
            .toBe(ALL_ROWS);
        expect(before.totalDuration).toBe(ALL_SECONDS);

        const outcome = adoptLegacyDatabase(legacy, target);

        expect(outcome.adopted, 'the adoption refused a database it should have moved').toBe(true);
        expect(fs.existsSync(target)).toBe(true);

        const after = readContent(target);
        expect(after.sessions, 'V2-SCHEMA-02: rows that lived only in the -wal were lost').toBe(ALL_ROWS);
        expect(after.totalDuration, 'tracked time was lost across the move').toBe(ALL_SECONDS);
        expect(after.digest, 'a row changed across the move').toBe(before.digest);
        expect(after.integrity).toBe('ok');
    });

    it('a rename of the database alone loses exactly those rows (the failure above, performed)', async () => {
        const { legacy, target } = walCase(await makeWalFixture());
        expect(readContent(legacy).sessions).toBe(ALL_ROWS);

        // Deliberately the wrong thing: the -wal stays behind under a name nothing will look for again.
        // eslint-disable-next-line no-restricted-syntax -- this IS the CUSTODY-03 failure, as a negative control
        fs.renameSync(legacy, target);

        expect(fs.existsSync(legacy + '-wal'), 'the orphaned sidecar is the whole point of this control').toBe(true);
        const after = readContent(target);
        expect(after.sessions, 'a naive rename must be visibly lossy, or the test above is vacuous')
            .toBe(CHECKPOINTED_ROWS);
        expect(after.totalDuration).toBe(CHECKPOINTED_ROWS * 3600);
    });

    it('leaves one database and no sidecar of the old name behind', async () => {
        const { legacy, target } = walCase(await makeWalFixture());

        adoptLegacyDatabase(legacy, target);

        expect(entriesIn(target), 'the adoption left the old name, or a sidecar, on disk')
            .toEqual([path.basename(target)]);
        expect(fs.existsSync(legacy)).toBe(false);
        expect(fs.existsSync(legacy + '-wal')).toBe(false);
        expect(fs.existsSync(legacy + '-shm')).toBe(false);
    });

    it('reports how much it folded in, so a silent no-op is visible', async () => {
        const { legacy, target } = walCase(await makeWalFixture());
        const outcome = adoptLegacyDatabase(legacy, target);

        expect(outcome.adopted).toBe(true);
        if (!outcome.adopted) return;
        expect(outcome.from).toBe(legacy);
        expect(outcome.walBytesFolded, 'the fixture holds uncheckpointed frames, so this cannot be 0')
            .toBeGreaterThan(0);
        expect(outcome.verification.integrity).toBe('ok');
        expect(outcome.verification.totalDuration, 'the verification counted only the checkpointed rows')
            .toBe(ALL_SECONDS);
    });
});

describe('V2-SCHEMA-02: it moves, and only when there is something to move', () => {
    it('moves rather than copies: the old name is gone, never left beside the new one', () => {
        const legacy = copyFixture(makeCleanFixture());
        const target = path.join(path.dirname(legacy), 'workflow.db');

        adoptLegacyDatabase(legacy, target);

        expect(entriesIn(target)).toEqual([path.basename(target)]);
    });

    it('leaves an existing workflow.db alone, and leaves krono.db beside it untouched', () => {
        const legacy = copyFixture(makeCleanFixture());
        const target = path.join(path.dirname(legacy), 'workflow.db');
        // A second, different database already at the new name: adopting over it would be the data-loss event.
        const planted = new Database(target);
        planted.exec('CREATE TABLE planted (id INTEGER PRIMARY KEY)');
        planted.close();

        const plantedBefore = fs.readFileSync(target);
        const legacyBefore = fs.readFileSync(legacy);

        const outcome = adoptLegacyDatabase(legacy, target);

        expect(outcome).toEqual({ adopted: false, reason: 'target-present' });
        expect(fs.readFileSync(target).equals(plantedBefore), 'the existing database was overwritten').toBe(true);
        expect(fs.readFileSync(legacy).equals(legacyBefore), 'the legacy database was touched').toBe(true);
    });

    it('does nothing when there is no krono.db to adopt', () => {
        const dir = tempDir('absent');
        const outcome = adoptLegacyDatabase(path.join(dir, 'krono.db'), path.join(dir, 'workflow.db'));

        expect(outcome).toEqual({ adopted: false, reason: 'nothing-to-adopt' });
        expect(fs.readdirSync(dir), 'nothing may be created when there is nothing to adopt').toEqual([]);
    });

    it('refuses a relative path rather than resolving it against the working directory', () => {
        const dir = tempDir('relative');
        expect(() => adoptLegacyDatabase('krono.db', path.join(dir, 'workflow.db'))).toThrow(/absolute/);
        expect(() => adoptLegacyDatabase(path.join(dir, 'krono.db'), 'workflow.db')).toThrow(/absolute/);
    });

    it('leaves the file where it was when it is not a database it can open', () => {
        const dir = tempDir('foreign');
        const legacy = path.join(dir, 'krono.db');
        const target = path.join(dir, 'workflow.db');
        fs.writeFileSync(legacy, 'this is not a SQLite database, and must not become workflow.db');
        const before = fs.readFileSync(legacy);

        expect(() => adoptLegacyDatabase(legacy, target)).toThrow();

        expect(fs.existsSync(target), 'an unreadable file was moved to the new name').toBe(false);
        expect(fs.readFileSync(legacy).equals(before), 'an unreadable file was altered').toBe(true);
    });
});

/*
 * The failure windows, named. The adoption has exactly one irreversible step - fs.renameSync, which within a
 * directory is atomic on NTFS and on POSIX alike - and it never copies, so there is no instant at which two
 * databases exist and no instant at which none does. What is checked below is the state on either side of that
 * step, reached by throwing from the kill points rather than by killing a process: an OS-level SIGKILL during
 * rename(2) resolves to one of these same two states by the guarantee the step rests on.
 */
describe('V2-SCHEMA-02: a crash mid-adoption leaves exactly one openable database', () => {
    const stop = (): never => { throw new Error('killed'); };

    it('stopping before the move leaves the whole database under the old name', async () => {
        const { legacy, target } = walCase(await makeWalFixture());

        expect(() => adoptLegacyDatabase(legacy, target, { beforeRename: stop })).toThrow(/killed/);

        expect(entriesIn(legacy), 'a stop before the move left something at the new name')
            .toEqual([path.basename(legacy)]);
        const left = readContent(legacy);
        expect(left.sessions, 'the checkpoint that precedes the move lost rows').toBe(ALL_ROWS);
        expect(left.totalDuration).toBe(ALL_SECONDS);
        expect(left.integrity).toBe('ok');
    });

    it('stopping after the move leaves the whole database under the new name', async () => {
        const { legacy, target } = walCase(await makeWalFixture());
        const before = readContent(legacy);

        expect(() => adoptLegacyDatabase(legacy, target, { afterRename: stop })).toThrow(/killed/);

        expect(entriesIn(target), 'a stop after the move left the old name behind as well')
            .toEqual([path.basename(target)]);
        const moved = readContent(target);
        expect(moved.sessions).toBe(ALL_ROWS);
        expect(moved.digest, 'a row changed across a move that was cut short').toBe(before.digest);
        expect(moved.integrity).toBe('ok');
    });

    it('copies nothing, so no window can exist in which two databases hold the same rows', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/db/adopt.ts'), 'utf8');
        expect(source, 'a copy leaves two databases that diverge silently (CUSTODY-03)')
            .not.toMatch(/fs\.(copyFile|copyFileSync|cp|cpSync)\(/);
        expect(source.match(/fs\.renameSync\(/g), 'the move is the only irreversible step, and the undo of it')
            .toHaveLength(2);
    });
});

/*
 * DATA CR-01. The "target wins outright" rule was one fs.existsSync at the top of the function, ~190 ms of
 * checkpoint, open/close and integrity_check before the move it guards. fs.renameSync replaces an existing target
 * silently on NTFS and on POSIX alike, so a workflow.db restored from a backup, materialised by a roaming profile
 * or dropped in by a sync client inside that window was destroyed and the adoption reported success.
 *
 * The window is reached here through the beforeRename kill point, which is the same instant a real file would
 * appear in - the hook is the last thing that runs before the irreversible step.
 */
describe('V2-SCHEMA-02: a database that appears at the new name during the move still wins', () => {
    const plant = (target: string) => (): void => {
        const planted = new Database(target);
        planted.exec('CREATE TABLE planted (id INTEGER PRIMARY KEY); INSERT INTO planted VALUES (1)');
        planted.close();
    };

    it('refuses rather than replacing a workflow.db that appeared inside the move', async () => {
        const { legacy, target } = walCase(await makeWalFixture());
        const before = readContent(legacy);

        expect(() => adoptLegacyDatabase(legacy, target, { beforeRename: plant(target) }))
            .toThrow(/appeared|already/i);

        const planted = new Database(target, { readonly: true, fileMustExist: true });
        try {
            expect(
                planted.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM planted').get()?.n,
                'the database that was at the new name was destroyed by the adoption'
            ).toBe(1);
        } finally {
            planted.close();
        }

        expect(fs.existsSync(legacy), 'the legacy database was moved onto a target it had no right to').toBe(true);
        const left = readContent(legacy);
        expect(left.sessions, 'the refusal cost the legacy database rows').toBe(ALL_ROWS);
        expect(left.digest, 'the refusal altered the legacy database').toBe(before.digest);
    });

    it('takes the move with an operation that fails on an existing target, not a check that precedes one', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/db/adopt.ts'), 'utf8');
        expect(
            source,
            'the move must be attempted with fs.linkSync, which fails EEXIST rather than replacing - a second ' +
            'existsSync narrows the window but cannot close it'
        ).toMatch(/fs\.linkSync\(/);
    });
});

/*
 * V2-SCHEMA-02: moves v1.2.1's krono.db to v2's workflow.db, with its -wal folded in first.
 *
 * The app runs in WAL mode (client.ts:9), so committed frames can live in krono.db-wal and nowhere else - the
 * state every user who was killed from the tray is in. SQLite will not look for krono.db-wal beside workflow.db,
 * so renaming the database alone destroys those transactions with no error anywhere. The checkpoint below is not
 * an optimisation; it is the whole of why this module exists (D-32, CUSTODY-03).
 *
 * A move, never a copy: a copy leaves two databases that diverge silently. The rename is the one irreversible
 * step and it is atomic within a directory, so a crash leaves exactly one openable database - under the old name
 * before it, under the new one after it, never none and never two.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describeVerificationMismatches, readDatabaseStats } from './backup';
import type { BackupVerification } from './backup';
import { closeDatabase, openDatabase } from './client';

const SIDECARS = ['-wal', '-shm'] as const;

export type AdoptionSkip = 'target-present' | 'nothing-to-adopt';

/** Test-only kill points either side of the one irreversible step, in the shape RunnerHooks uses (D-24). */
export interface AdoptionHooks {
    readonly beforeRename?: () => void;
    readonly afterRename?: () => void;
}

export type AdoptionOutcome =
    | { readonly adopted: false; readonly reason: AdoptionSkip }
    | {
        readonly adopted: true;
        readonly from: string;
        /** How much of the database was living in the sidecar when the move began. */
        readonly walBytesFolded: number;
        readonly verification: BackupVerification;
    };

const sizeOf = (file: string): number => (fs.existsSync(file) ? fs.statSync(file).size : 0);

function requireAbsolute(label: string, dbPath: string): void {
    if (!path.isAbsolute(dbPath)) {
        throw new Error(
            'adoptLegacyDatabase requires an absolute ' + label + ' path, got "' + dbPath + '". A relative path ' +
            'resolves against whatever working directory launched the app, so the same build would move a ' +
            'different file depending on how it was started (Y8).'
        );
    }
}

/*
 * TRUNCATE folds every committed frame into the database and leaves the -wal at zero bytes. The journal mode is
 * deliberately left alone (WR-01): writing it rewrites the file header, and nothing here may mutate a database it
 * has not yet proved it can move. The close is what deletes the sidecars.
 */
function checkpointAndClose(dbPath: string): void {
    const db = openDatabase(dbPath, { deferJournalMode: true });
    try {
        const rows = db.pragma('wal_checkpoint(TRUNCATE)');
        const result = Array.isArray(rows) ? (rows[0] as { busy?: unknown } | undefined) : undefined;
        if (result?.busy !== 0) {
            throw new Error(
                'PRAGMA wal_checkpoint(TRUNCATE) on ' + dbPath + ' reported busy ' + JSON.stringify(result?.busy) +
                ', expected 0. Something else is holding the write-ahead log open, and moving the database now ' +
                'would leave whatever is in it behind.'
            );
        }
    } finally {
        closeDatabase(db);
    }
}

/*
 * Removes the empty sidecars a checkpointed close or a read-only connection leaves, and refuses to go on if the
 * -wal still holds anything: a non-empty -wal beside a database that is about to be renamed is the one state in
 * which this operation loses data.
 */
function requireQuiescent(dbPath: string, stage: string): void {
    for (const sidecar of SIDECARS) {
        const companion = dbPath + sidecar;
        if (!fs.existsSync(companion)) continue;
        const size = fs.statSync(companion).size;
        if (sidecar === '-wal' && size > 0) {
            throw new Error(
                dbPath + sidecar + ' still holds ' + String(size) + ' bytes ' + stage + '. Those are committed ' +
                'transactions that live nowhere else, and SQLite would not look for this file beside the new ' +
                'name, so the database has been left exactly where it was.'
            );
        }
        fs.rmSync(companion);
    }
}

/**
 * Moves `legacyPath` to `targetPath` once its -wal is folded in and its contents verify on both sides.
 * Returns without touching anything when the target already exists or the source does not.
 */
export function adoptLegacyDatabase(
    legacyPath: string,
    targetPath: string,
    hooks: AdoptionHooks = {}
): AdoptionOutcome {
    requireAbsolute('source', legacyPath);
    requireAbsolute('target', targetPath);

    // The target wins outright. Adopting over a database already at the new name is the data-loss event.
    if (fs.existsSync(targetPath)) return { adopted: false, reason: 'target-present' };
    if (!fs.existsSync(legacyPath)) return { adopted: false, reason: 'nothing-to-adopt' };

    const walBytesFolded = sizeOf(legacyPath + '-wal');

    // Throws on anything SQLite will not open, which leaves a foreign file exactly where it was.
    checkpointAndClose(legacyPath);
    requireQuiescent(legacyPath, 'after the checkpoint');

    const before = readDatabaseStats(legacyPath);
    requireQuiescent(legacyPath, 'after reading it back');

    hooks.beforeRename?.();
    // The irreversible step, and the only one. Within a directory this is atomic on NTFS and on POSIX alike.
    // eslint-disable-next-line no-restricted-syntax -- moving a quiesced database intact, never copying it (CUSTODY-03)
    fs.renameSync(legacyPath, targetPath);
    hooks.afterRename?.();

    const verification = readDatabaseStats(targetPath);
    const mismatches = describeVerificationMismatches(before, verification);
    if (mismatches.length > 0) {
        // Put it back under the name the user's other copies of Workflow still look for, then say why.
        // eslint-disable-next-line no-restricted-syntax -- undoing this module's own move (CUSTODY-03)
        fs.renameSync(targetPath, legacyPath);
        throw new Error(
            'Refusing to adopt ' + legacyPath + ' as ' + targetPath + ': ' + mismatches.join('; ') +
            '. The database has been moved back to the name it had.'
        );
    }
    requireQuiescent(targetPath, 'after reading it back');

    return { adopted: true, from: legacyPath, walBytesFolded, verification };
}

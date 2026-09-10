/*
 * src/lib/db/client.ts
 *
 * Open and close the application's SQLite connection, at a path the caller supplies.
 *
 * The failure this shape prevents is irreversible: a connection opened at the wrong moment or at
 * the wrong path writes to a database nobody meant to touch. database/db.js is the anti-analog,
 * with three defects in six lines - it imports electron from an infrastructure module, derives
 * its path from Electron's userData directory (app.getPath, written here without its call
 * parentheses on purpose, because this repository's module-shape gates grep source text and
 * cannot tell prose from code), and opens the connection at MODULE LOAD, before any lifecycle
 * hook has run. main.js requires it on its sixth line, so the connection exists before
 * app.whenReady and before any single-instance lock could have been taken: two copies of the app
 * started together both open the same file. BUILD-03 and BUILD-04 forbid all three.
 *
 * So, deliberately, and following src/lib/db/backup.ts exactly:
 *
 * 1. IT IMPORTS ONLY NODE BUILTINS AND THE DRIVER. No Electron import, so it loads in plain Node
 *    and is unit-testable under Vitest without an in-Electron runner.
 * 2. THE PATH IS INJECTED. Deciding which file holds a user's tracked time is the main process's
 *    job (src/main/userdata-path.ts, Phase 4's migration runner), not this module's.
 * 3. NO CONNECTION EXISTS UNTIL openDatabase IS CALLED. Importing this module has no side effect,
 *    so src/main/index.ts can import it only after the single-instance lock is held.
 * 4. THE PATH MUST BE ABSOLUTE. A relative path resolves against the process's working directory,
 *    which is whatever launched the app - the exact class of bug main.js line 62 carries (Y8).
 *
 * Connection lifecycle beyond open/close - reference counting, re-entrancy, migrations - is
 * Phase 4's. A second openDatabase call on the same file opens a second handle; the
 * single-instance lock, not this module, is what keeps a second PROCESS off the file.
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';

/** The journal mode v1.2.1 has always used. Kept, so an existing krono.db sees no mode change. */
export const JOURNAL_MODE_PRAGMA = 'journal_mode = WAL';

/** What SQLite reports back once JOURNAL_MODE_PRAGMA has taken effect on a file database. */
export const EXPECTED_JOURNAL_MODE = 'wal';

/**
 * Opens the SQLite database at `dbPath` (creating it if absent) with WAL journaling applied, and
 * returns the handle. Throws - and leaves no connection open - if the path is relative or if the
 * journal mode did not take effect.
 */
export function openDatabase(dbPath: string): DatabaseType.Database {
    if (!path.isAbsolute(dbPath)) {
        throw new Error(
            'openDatabase requires an absolute path, got "' + dbPath + '". A relative path ' +
            'resolves against whatever working directory launched the app, so the same build ' +
            'would open a different file depending on how it was started (Y8).'
        );
    }

    const db = new Database(dbPath);
    try {
        const mode = db.pragma(JOURNAL_MODE_PRAGMA, { simple: true });
        if (typeof mode !== 'string' || mode.toLowerCase() !== EXPECTED_JOURNAL_MODE) {
            throw new Error(
                'PRAGMA ' + JOURNAL_MODE_PRAGMA + ' on ' + dbPath + ' reported ' +
                JSON.stringify(mode) + ', expected "' + EXPECTED_JOURNAL_MODE + '".'
            );
        }
    } catch (error) {
        db.close();
        throw error;
    }
    return db;
}

/**
 * Closes a handle returned by openDatabase. Closing an already-closed handle is a no-op, so a
 * `finally` block can call this unconditionally.
 */
export function closeDatabase(db: DatabaseType.Database): void {
    if (db.open) {
        db.close();
    }
}

// Opens and closes the SQLite connection at an injected absolute path; imports only node:path and the driver.
// No connection exists until openDatabase runs, so importing this module has no side effect (BUILD-04).

import path from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';

// v1.2.1's journal mode, kept so an existing krono.db sees no change.
export const JOURNAL_MODE_PRAGMA = 'journal_mode = WAL';

export const EXPECTED_JOURNAL_MODE = 'wal';

// Issued by every connection itself; the driver's compiled-in default is not relied on (D-16).
export const FOREIGN_KEYS_PRAGMA = 'foreign_keys = ON';

export const BUSY_TIMEOUT_MS = 5_000;

export interface OpenDatabaseOptions {
    // Test-only statement trace. It expands bound values (company names, notes), so never pass it in production.
    verbose?: DatabaseType.Options['verbose'];
    // WR-01: leave the journal mode alone, so a delete-journal file is not rewritten before its backup exists.
    // The caller then owes the database a setJournalModeWal once the backup is taken.
    deferJournalMode?: boolean;
}

// Issues FOREIGN_KEYS_PRAGMA and reads it back. Inside a transaction the pragma is a no-op, hence the read-back.
export function assertForeignKeysOn(db: DatabaseType.Database, label: string): void {
    db.pragma(FOREIGN_KEYS_PRAGMA);
    const observed = db.pragma('foreign_keys', { simple: true });
    if (observed !== 1) {
        throw new Error(
            'PRAGMA ' + FOREIGN_KEYS_PRAGMA + ' on ' + label + ' reads back ' + JSON.stringify(observed) +
            ', expected 1.'
        );
    }
}

// Issues JOURNAL_MODE_PRAGMA and reads it back; the mode lives in the file header, so this rewrites the database.
export function setJournalModeWal(db: DatabaseType.Database, label: string): void {
    const mode = db.pragma(JOURNAL_MODE_PRAGMA, { simple: true });
    if (typeof mode !== 'string' || mode.toLowerCase() !== EXPECTED_JOURNAL_MODE) {
        throw new Error(
            'PRAGMA ' + JOURNAL_MODE_PRAGMA + ' on ' + label + ' reported ' +
            JSON.stringify(mode) + ', expected "' + EXPECTED_JOURNAL_MODE + '".'
        );
    }
}

// Throws, leaving no connection open, on a relative path or on a pragma that did not take effect.
export function openDatabase(dbPath: string, options: OpenDatabaseOptions = {}): DatabaseType.Database {
    if (!path.isAbsolute(dbPath)) {
        throw new Error(
            'openDatabase requires an absolute path, got "' + dbPath + '". A relative path ' +
            'resolves against whatever working directory launched the app, so the same build ' +
            'would open a different file depending on how it was started (Y8).'
        );
    }

    const db = new Database(dbPath, options.verbose === undefined ? {} : { verbose: options.verbose });
    try {
        assertForeignKeysOn(db, dbPath);
        db.pragma('busy_timeout = ' + String(BUSY_TIMEOUT_MS));
        if (options.deferJournalMode !== true) {
            setJournalModeWal(db, dbPath);
        }
    } catch (error) {
        db.close();
        throw error;
    }
    return db;
}

// Idempotent, so a `finally` can call it unconditionally.
export function closeDatabase(db: DatabaseType.Database): void {
    if (db.open) {
        db.close();
    }
}

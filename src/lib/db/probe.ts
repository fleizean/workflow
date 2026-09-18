// Reads what classify needs through a read-only connection, so an unclassified file is never written (D-12).
// A missing file is reported without opening anything; a file SQLite cannot read becomes { ok: false }.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';
import { V1X_TABLES, type ObservedDatabase, type V1xTable } from './classify';
import { assertForeignKeysOn } from './client';

export type ProbeResult = { ok: true; observed: ObservedDatabase } | { ok: false; reason: string };

export interface ProbeOptions {
    // Test-only statement trace; never passed in production.
    verbose?: DatabaseType.Options['verbose'];
}

function describeFailure(error: unknown): string {
    if (error instanceof Error) {
        const code = (error as { code?: unknown }).code;
        return (typeof code === 'string' ? code + ': ' : '') + error.message;
    }
    return String(error);
}

export function probeDatabase(dbPath: string, options: ProbeOptions = {}): ProbeResult {
    if (!path.isAbsolute(dbPath)) {
        return { ok: false, reason: 'The database path must be absolute, got "' + dbPath + '".' };
    }
    if (!fs.existsSync(dbPath)) {
        return { ok: true, observed: { exists: false, userVersion: 0, objects: [], columns: {} } };
    }

    const settings: DatabaseType.Options = { readonly: true, fileMustExist: true };
    if (options.verbose !== undefined) settings.verbose = options.verbose;

    let db: DatabaseType.Database;
    try {
        db = new Database(dbPath, settings);
    } catch (error) {
        return { ok: false, reason: 'Could not open ' + dbPath + ' read-only - ' + describeFailure(error) };
    }
    try {
        assertForeignKeysOn(db, dbPath);
        const userVersion = db.pragma('user_version', { simple: true });
        if (typeof userVersion !== 'number') {
            return { ok: false, reason: 'PRAGMA user_version on ' + dbPath + ' returned ' + typeof userVersion + '.' };
        }
        const objects = db.prepare<[], { type: string; name: string }>('SELECT type, name FROM sqlite_master').all();
        const columns: Partial<Record<V1xTable, readonly string[]>> = {};
        const readColumns = db.prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid');
        for (const table of V1X_TABLES) {
            if (objects.some((object) => object.type === 'table' && object.name === table)) {
                columns[table] = readColumns.all(table).map((column) => column.name);
            }
        }
        return { ok: true, observed: { exists: true, userVersion, objects, columns } };
    } catch (error) {
        return { ok: false, reason: 'Could not read ' + dbPath + ' as a SQLite database - ' + describeFailure(error) };
    } finally {
        db.close();
    }
}

// The Drizzle handle every repository is constructed with. Wraps a connection the caller already opened, so loading
// this module still opens nothing (BUILD-04) and the lock-ordering rule is unchanged (D-10, D-15).

import { drizzle } from 'drizzle-orm/better-sqlite3';
import type DatabaseType from 'better-sqlite3';

export type DbHandle = ReturnType<typeof createDbHandle>;

export function createDbHandle(connection: DatabaseType.Database) {
    return drizzle(connection);
}

/**
 * One BEGIN IMMEDIATE around `work`. better-sqlite3 is synchronous and single-connection, so every repository built
 * on the same handle is inside it without being passed anything.
 */
export function transact<T>(handle: DbHandle, work: () => T): T {
    return handle.$client.transaction(work).immediate();
}

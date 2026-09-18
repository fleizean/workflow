// The ordered list the runner walks: v1 is the imperative v1.2.1 baseline, v2 onward are generated SQL (D-06, D-08).
// Explicit ?raw imports only - no glob, no fs, no journal read.

import historyIndexesAppState from './0001_history_indexes_app_state.sql?raw';
import sheetsRetirement from './0002_sheets_retirement.sql?raw';
import type { MigrationStep } from '../runner';

export const MIGRATIONS: readonly MigrationStep[] = Object.freeze([
    { version: 1, tag: '0000_v121_baseline', kind: 'baseline' },
    {
        version: 2,
        tag: '0001_history_indexes_app_state',
        kind: 'sql',
        sql: historyIndexesAppState,
        // The step's CREATE TABLE is IF NOT EXISTS, so an app_state already there in another shape is a no-op.
        ensures: [{ table: 'app_state', columns: ['key', 'value', 'updated_at'] }]
    },
    {
        version: 3,
        tag: '0002_sheets_retirement',
        kind: 'sql',
        sql: sheetsRetirement,
        // V2-SCHEMA-01: the one step that takes something away. Version 1 always leaves both columns on companies,
        // so the drops cannot miss; what is checked here is that they took nothing else with them, inside the
        // step's own transaction and before the version bump.
        ensures: [{ table: 'companies', columns: ['id', 'name', 'created_at', 'updated_at', 'note_required'] }]
    }
] as const);

export const LATEST = MIGRATIONS.length;

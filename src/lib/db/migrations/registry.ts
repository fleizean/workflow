// The ordered list the runner walks: v1 is the imperative v1.2.1 baseline, v2 onward are generated SQL (D-06, D-08).
// Explicit ?raw imports only - no glob, no fs, no journal read.

import historyIndexesAppState from './0001_history_indexes_app_state.sql?raw';
import type { MigrationStep } from '../runner';

export const MIGRATIONS: readonly MigrationStep[] = Object.freeze([
    { version: 1, tag: '0000_v121_baseline', kind: 'baseline' },
    { version: 2, tag: '0001_history_indexes_app_state', kind: 'sql', sql: historyIndexesAppState }
] as const);

export const LATEST = MIGRATIONS.length;

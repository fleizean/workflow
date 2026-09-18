// The SHA-256 approved at the D-21 schema door, committed alongside the files it pins (D-09, D-21).
// Copied from the approval record, never recomputed from the files: a pin derived from the bytes it pins proves nothing.
//
// 0001 was re-approved for WR-04: every CREATE in it gained IF NOT EXISTS, so an adopted database that already
// carries one of the three index names is migrated rather than failed on every launch.
//
// 0002 is the one destructive migration this project has (V2-SCHEMA-01). Its two DROP COLUMNs are drizzle-kit's
// own output for a schema.ts without those columns; its two DELETEs are hand-written, because drizzle knows
// schemas and not rows. Both halves are on the additive guard's named exception and nothing else is.

export const PINNED_SQL_SHA256: Readonly<Record<string, string>> = Object.freeze({
    '0000_v121_baseline': 'cb3bc3870adc593403051ee1626ddc9ef4e5b71dade187f8de0300959dc6e8f2',
    '0001_history_indexes_app_state': 'd801d438ebb6bb25d3ec30a2607f2edb2c7f08156f95492f523714cb0d82c76b',
    '0002_sheets_retirement': 'c57a3facef2f5c3dd140124fda63001d2411c32f684a859931c32ca1b90a06b7'
});

// The SHA-256 approved at the D-21 schema door, committed alongside the files it pins (D-09, D-21).
// Copied from the approval record, never recomputed from the files: a pin derived from the bytes it pins proves nothing.

export const PINNED_SQL_SHA256: Readonly<Record<string, string>> = Object.freeze({
    '0000_v121_baseline': 'cb3bc3870adc593403051ee1626ddc9ef4e5b71dade187f8de0300959dc6e8f2',
    '0001_history_indexes_app_state': '2318441a51246ad85639e84d4c2bb683a42bac4c0dafa165f38111a233139117'
});

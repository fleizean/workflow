#!/usr/bin/env bash
#
# tools/baseline/inventory.sh — CUSTODY-09 behaviour inventory generator.
#
# WHY THIS IS A SCRIPT AND NOT A HAND-WRITTEN LIST
#
# Phase 8 (REL-06, SPA-14) deletes src/pages/*.html on the strength of the parity
# checklist next to these artifacts. That is a one-way door: once the four HTML pages
# are gone, the record of what they did is git archaeology. A list produced by reading
# and typing is stale the moment it is written. This script can be re-run against the
# NEW tree in Phase 8 and diffed against the committed v1.2.1 artifacts, which turns
# "did we reimplement everything?" from a memory exercise into a diff.
#
# WHAT IT READS
#
# Source text only: src/**/*.{html,js}, preload.js, main.js. It opens no database,
# launches no application and copies no user content. Safe to run at any point in the
# milestone, including before the better-sqlite3 upgrade barrier (plan 01-07).
#
# DETERMINISM
#
# Re-running against an unchanged tree must produce byte-identical output, otherwise a
# Phase 8 diff drowns the real changes in reordering noise. The two .txt listings are
# sorted; the two .tsv listings are sorted by (file, line) under LC_ALL=C. grep -r
# already emits that order on this tree, so the explicit sort changes nothing today —
# it guarantees the order on a filesystem whose directory-entry order differs (the
# Ubuntu CI runner is not NTFS).
#
# Trailing carriage returns are stripped from snippets: the repository checks out CRLF
# (.gitattributes, D-13), and leaving a bare CR inside a TSV field makes the artifact
# awkward to read and to parse from TypeScript.
#
# USAGE
#
#   bash tools/baseline/inventory.sh
#
# Prints the five counts as key=value pairs on stdout so a human sees the numbers
# without opening a file, and a future CI step can grep them.
#
# The pinned counts (106 / 21 / 67 / 25 / 25) are asserted by tests/inventory.test.ts,
# which recomputes them from the live tree and also compares the two committed .txt
# artifacts element-wise. A source change that is not regenerated fails CI rather than
# leaving a stale file that still looks authoritative (threat T-01-11).

set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

OUT="baselines/v1.2.1"
mkdir -p "$OUT"

# grep -rn emits "<file>:<line>:<text>". File paths here contain no colon, so the
# first two fields split unambiguously. The trailing [[:space:]]* trims the source
# indentation from the snippet; s/\r$// drops the CRLF carriage return.
reshape() {
    sed -e 's/^\([^:]*\):\([0-9]*\):[[:space:]]*/\1\t\2\t/' -e 's/\r$//' \
        | LC_ALL=C sort -t "$(printf '\t')" -k1,1 -k2,2n
}

# 1. Every event-handler registration site in the renderer.
grep -rn "addEventListener" --include=*.html --include=*.js src/ \
    | reshape > "$OUT/handlers.tsv"

# 2. Every window.api.<name> reference in the renderer. This is the demand side of the
#    IPC contract; preload-surface.txt below is the supply side, and the two disagree
#    (5 exposed-never-called, 1 called-never-exposed — see PARITY-CHECKLIST.md).
grep -rn "window\.api\.[A-Za-z0-9_]*" --include=*.html --include=*.js src/ \
    | reshape > "$OUT/api-calls.tsv"

# 3. The preload bridge surface — the contract Phase 6 (IPC-01) must reproduce.
#    Depends on contextBridge.exposeInMainWorld's object literal keeping one property
#    per line at four-space indent, which holds today. Two properties on one line would
#    undercount; the fix then is to widen this extraction, never to relax the pinned
#    number in tests/inventory.test.ts.
grep -o "^    [a-zA-Z0-9_]*:" preload.js \
    | tr -d ' :' | LC_ALL=C sort > "$OUT/preload-surface.txt"

# 4. The ipcMain channels main.js answers on.
grep -o "ipcMain\.\(handle\|on\)('[^']*'" main.js \
    | sed "s/.*('//;s/'//" | LC_ALL=C sort > "$OUT/ipc-channels.txt"

handler_sites=$(wc -l < "$OUT/handlers.tsv")
api_call_sites=$(wc -l < "$OUT/api-calls.tsv")
api_names=$(grep -roh "window\.api\.[A-Za-z0-9_]*" --include=*.html --include=*.js src/ \
    | sed 's/window\.api\.//' | tr -d '\r' | LC_ALL=C sort -u | wc -l)
preload_apis=$(wc -l < "$OUT/preload-surface.txt")
ipc_channels=$(wc -l < "$OUT/ipc-channels.txt")

printf 'handler_sites=%s\n'   "$(echo "$handler_sites"   | tr -d ' ')"
printf 'api_names=%s\n'       "$(echo "$api_names"       | tr -d ' ')"
printf 'api_call_sites=%s\n'  "$(echo "$api_call_sites"  | tr -d ' ')"
printf 'preload_apis=%s\n'    "$(echo "$preload_apis"    | tr -d ' ')"
printf 'ipc_channels=%s\n'    "$(echo "$ipc_channels"    | tr -d ' ')"

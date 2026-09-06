#!/usr/bin/env bash
#
# CUSTODY-08 - obtain the shipped v1.2.1 installer reproducibly, without committing it.
#
# The two release assets are 87.6 MB and 111.3 MB. D-03 forbids putting them in this public
# repository, so they are pinned by release tag + asset name + byte size + SHA-256 in
# baselines/v1.2.1/MANIFEST.md and fetched on demand by this script. Phase 10 / REL-04 installs
# the new build over v1.2.1; that test is meaningless against a different binary, which is what
# the digest check exists to prevent (T-01-15).
#
# The URL uses the post-rename owner/name pair `fleizean/workflow` directly. The old
# `fleizean/workflow-timer` path still 301-redirects, but a redirect is a dependency on GitHub
# continuing to honour it and there is no reason to take it (T-01-16).
#
# Usage:
#   bash tools/baseline/fetch-installer.sh <dest-path> [--mac]
#   bash tools/baseline/fetch-installer.sh --check-pin [--mac]
#
# Exit codes are distinct on purpose. "I could not reach the network" and "the pin no longer
# describes the asset" demand opposite responses, and a single non-zero exit conflates them.
#   0  ok
#   2  usage error
#   3  COULD NOT CHECK - DNS / proxy / TLS / timeout. Says nothing about the pin.
#   4  PIN DRIFT - the server answered and its answer disagrees with the manifest.
#   5  CHECKSUM MISMATCH - the payload arrived and is not the pinned binary. Treat as hostile.

set -euo pipefail

readonly EXIT_USAGE=2
readonly EXIT_NETWORK=3
readonly EXIT_PIN_DRIFT=4
readonly EXIT_CHECKSUM=5

readonly TAG='v2026.03.03-312cd77'
readonly RELEASE_BASE="https://github.com/fleizean/workflow/releases/download/${TAG}"
readonly RELEASE_PAGE="https://github.com/fleizean/workflow/releases/tag/${TAG}"

readonly WIN_ASSET='Workflow.Setup.1.2.1.exe'
readonly WIN_BYTES='87594571'
readonly WIN_SHA256='e0b19426708728597f17088048a1ff5ad247fcf139ab4823710163f4d112c7f0'

readonly MAC_ASSET='Workflow-1.2.1-arm64.dmg'
readonly MAC_BYTES='111250721'
readonly MAC_SHA256='d59b210678b1e8589c44da36088a6c509c8e1903e22859efa32ad926a50fa6f4'

usage() {
    {
        echo 'usage: fetch-installer.sh <dest-path> [--mac]     download and verify the pinned asset'
        echo '       fetch-installer.sh --check-pin [--mac]     verify the pin by HEAD request only'
        echo ''
        echo '  --mac        select Workflow-1.2.1-arm64.dmg instead of Workflow.Setup.1.2.1.exe'
        echo '  --check-pin  follow redirects with a HEAD request and compare the reported'
        echo '               content-length against the pinned byte size. Downloads no payload.'
        echo ''
        echo 'The pinned values live in baselines/v1.2.1/MANIFEST.md. Never commit the downloaded'
        echo 'binary: it is 83.5 MB / 106 MB and this repository is public (D-03).'
    } >&2
}

# --- argument parsing --------------------------------------------------------------------

CHECK_PIN=0
PLATFORM='win'
DEST=''

for arg in "$@"; do
    case "$arg" in
        --check-pin) CHECK_PIN=1 ;;
        --mac)       PLATFORM='mac' ;;
        --win)       PLATFORM='win' ;;
        -h|--help)   usage; exit 0 ;;
        -*)          printf 'error: unknown option %s\n' "$arg" >&2; usage; exit "$EXIT_USAGE" ;;
        *)
            if [ -n "$DEST" ]; then
                printf 'error: more than one destination given\n' >&2
                usage
                exit "$EXIT_USAGE"
            fi
            DEST="$arg"
            ;;
    esac
done

if [ "$CHECK_PIN" -eq 0 ] && [ -z "$DEST" ]; then
    printf 'error: a destination path is required unless --check-pin is used\n' >&2
    usage
    exit "$EXIT_USAGE"
fi

if [ "$PLATFORM" = 'mac' ]; then
    ASSET="$MAC_ASSET"; EXPECT_BYTES="$MAC_BYTES"; EXPECT_SHA256="$MAC_SHA256"
else
    ASSET="$WIN_ASSET"; EXPECT_BYTES="$WIN_BYTES"; EXPECT_SHA256="$WIN_SHA256"
fi
URL="${RELEASE_BASE}/${ASSET}"

# --- D-03 containment: never land an 83.5 MB binary inside the working tree ---------------
# .gitignore excludes *.db but not *.exe or *.dmg, so a download into the repo is one
# `git add -A` away from a public commit. Refuse the destination rather than rely on care.
refuse_in_repo() {
    local dest="$1" repo_root dest_dir dest_abs
    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "$repo_root" ] || return 0
    repo_root="$(cd "$repo_root" && pwd -P)"
    dest_dir="$(dirname -- "$dest")"
    mkdir -p -- "$dest_dir"
    dest_abs="$(cd "$dest_dir" && pwd -P)/$(basename -- "$dest")"
    case "$dest_abs" in
        "$repo_root"|"$repo_root"/*)
            printf 'REFUSED: %s is inside the repository working tree (%s).\n' "$dest_abs" "$repo_root" >&2
            printf 'REFUSED: the v1.2.1 installers are never committed (D-03). Choose a path outside the repo.\n' >&2
            return 1
            ;;
    esac
    return 0
}

# --- --check-pin -------------------------------------------------------------------------

if [ "$CHECK_PIN" -eq 1 ]; then
    err_file="$(mktemp)"
    trap 'rm -f "$err_file"' EXIT
    set +e
    headers="$(curl -fsSIL --retry 2 --max-time 60 "$URL" 2>"$err_file")"
    curl_status=$?
    set -e

    if [ "$curl_status" -ne 0 ]; then
        if [ "$curl_status" -eq 22 ]; then
            printf 'PIN DRIFT: the pinned asset URL returned an HTTP error.\n' >&2
            printf '  url: %s\n' "$URL" >&2
            printf '  %s\n' "$(tr -d '\r' < "$err_file" | tail -n 1)" >&2
            printf '  The release page is %s\n' "$RELEASE_PAGE" >&2
            exit "$EXIT_PIN_DRIFT"
        fi
        printf 'COULD NOT CHECK: curl failed to reach the host (exit %s).\n' "$curl_status" >&2
        printf '  This is a DNS, proxy, TLS or timeout failure. It says NOTHING about the pin.\n' >&2
        printf '  %s\n' "$(tr -d '\r' < "$err_file" | tail -n 1)" >&2
        exit "$EXIT_NETWORK"
    fi

    actual_bytes="$(printf '%s\n' "$headers" \
        | tr -d '\r' \
        | grep -i '^content-length:' \
        | tail -n 1 \
        | awk '{print $2}')"

    if [ -z "$actual_bytes" ]; then
        printf 'COULD NOT CHECK: no content-length header in the response.\n' >&2
        printf '  A proxy that rewrites HEAD responses produces this. It is not pin drift.\n' >&2
        exit "$EXIT_NETWORK"
    fi

    if [ "$actual_bytes" != "$EXPECT_BYTES" ]; then
        printf 'PIN DRIFT: %s is %s bytes, the manifest pins %s.\n' "$ASSET" "$actual_bytes" "$EXPECT_BYTES" >&2
        printf '  Do NOT update the manifest to match. A release asset that changed size under a\n' >&2
        printf '  fixed tag means the artifact users installed is no longer what that tag serves.\n' >&2
        exit "$EXIT_PIN_DRIFT"
    fi

    printf 'PIN OK: %s  %s bytes  (tag %s)\n' "$ASSET" "$actual_bytes" "$TAG"
    printf 'PIN OK: sha256 %s is unverified by this mode - download to check it.\n' "$EXPECT_SHA256"
    exit 0
fi

# --- download and verify -------------------------------------------------------------------

refuse_in_repo "$DEST" || exit "$EXIT_USAGE"

printf 'Fetching %s (%s bytes) from %s\n' "$ASSET" "$EXPECT_BYTES" "$RELEASE_BASE" >&2

set +e
curl -fSL --retry 2 --max-time 1800 -o "$DEST" "$URL"
curl_status=$?
set -e

if [ "$curl_status" -ne 0 ]; then
    rm -f -- "$DEST"
    if [ "$curl_status" -eq 22 ]; then
        printf 'PIN DRIFT: the pinned asset URL returned an HTTP error. See %s\n' "$RELEASE_PAGE" >&2
        exit "$EXIT_PIN_DRIFT"
    fi
    printf 'COULD NOT FETCH: curl exit %s - network failure, not pin drift.\n' "$curl_status" >&2
    exit "$EXIT_NETWORK"
fi

if ! printf '%s  %s\n' "$EXPECT_SHA256" "$DEST" | sha256sum -c -; then
    printf 'CHECKSUM MISMATCH: %s does not hash to the pinned digest.\n' "$DEST" >&2
    printf '  expected %s\n' "$EXPECT_SHA256" >&2
    printf '  Do NOT use this file for the Phase 10 upgrade test. Delete it and investigate.\n' >&2
    exit "$EXIT_CHECKSUM"
fi

printf 'OK: %s verified against the pinned SHA-256 and saved to %s\n' "$ASSET" "$DEST"

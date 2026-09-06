# v1.2.1 Baseline Manifest

The record of *which artifacts* the v1.2.1 baseline is made of, and how to obtain the ones that
are too large — or too private — to live in this repository.

Produced by plan `01-04` (CUSTODY-07, CUSTODY-08). Extended by plans `01-05` and `01-06`; see the
reserved sections at the end, which are meant to be **filled in place rather than duplicated**.

---

## 1. Pinned release (CUSTODY-08)

The shipped v1.2.1 installers are the fixture Phase 10 / REL-04 tests against: it installs the new
build over v1.2.1 on a machine with a populated database. That test is only meaningful against the
binary users actually installed, so the release is pinned by tag **and** by content digest.

| Field | Value |
|---|---|
| Release tag | `v2026.03.03-312cd77` |
| Target | `main` @ `312cd77` (the `main` HEAD this restructure branched from) |
| Published | `2026-03-03T06:39:44Z` |
| Release page | <https://github.com/fleizean/workflow/releases/tag/v2026.03.03-312cd77> |
| Repository | `fleizean/workflow` (numeric id `1122837169`) |
| Values retrieved | live from the GitHub API, 2026-09-05 |

### Assets

| Platform | Asset name | Bytes | SHA-256 |
|---|---|---|---|
| Windows (NSIS) | `Workflow.Setup.1.2.1.exe` | 87,594,571 | `e0b19426708728597f17088048a1ff5ad247fcf139ab4823710163f4d112c7f0` |
| macOS (arm64) | `Workflow-1.2.1-arm64.dmg` | 111,250,721 | `d59b210678b1e8589c44da36088a6c509c8e1903e22859efa32ad926a50fa6f4` |

Download URLs are the tag path under the asset name:

```
https://github.com/fleizean/workflow/releases/download/v2026.03.03-312cd77/Workflow.Setup.1.2.1.exe
https://github.com/fleizean/workflow/releases/download/v2026.03.03-312cd77/Workflow-1.2.1-arm64.dmg
```

### Obtaining and verifying

```bash
# Windows installer, verified against the pinned digest. The destination must be outside
# this repository; the script refuses an in-repo path.
bash tools/baseline/fetch-installer.sh ~/workflow-timer-archive/installers/Workflow.Setup.1.2.1.exe

# macOS disk image
bash tools/baseline/fetch-installer.sh ~/workflow-timer-archive/installers/Workflow-1.2.1-arm64.dmg --mac

# Cheap liveness check: HEAD only, compares the reported content-length against the pin.
# Downloads no payload, so it is usable in CI and in a per-task gate.
bash tools/baseline/fetch-installer.sh --check-pin
bash tools/baseline/fetch-installer.sh --check-pin --mac
```

`tools/baseline/fetch-installer.sh` uses distinct exit codes because "I could not reach the
network" and "the pin no longer describes the asset" demand opposite responses:

| Exit | Meaning | What to do |
|---|---|---|
| `0` | verified | proceed |
| `2` | usage error, or a destination inside this repository | choose a path outside the repo |
| `3` | **COULD NOT CHECK** — DNS, proxy, TLS or timeout | says nothing about the pin; retry with network |
| `4` | **PIN DRIFT** — the server answered and disagrees with this table | investigate; do **not** edit this table to match |
| `5` | **CHECKSUM MISMATCH** — a payload arrived and is not the pinned binary | treat as hostile; delete the file |

### Why the binaries are not committed

83.5 MB and 106 MB. D-03 forbids putting the owner's real database in this public repository
because the content cannot be un-published; the same repository-is-public reasoning applies to
size, and a 190 MB pair of blobs in git history is equally permanent. The digest is the artifact;
the binary is reproducible from it.

`.gitignore` excludes `*.db`, `*.db-shm` and `*.db-wal` but **not** `*.exe` or `*.dmg`. Stated
plainly, therefore: **the installer binaries must never be added to this repository.**
`tests/custody-hygiene.test.ts` and the `verify` workflow both fail if one ever is.

### Two caveats, so a future reader does not conclude the link is broken

1. **This is an asset of an auto-generated release, and no newer equivalent will appear.** The old
   `build-release.yml` published a release on every push to `main`; CUSTODY-01 has stopped that
   (D-06 — releases now come only from a version tag or a manual dispatch, and are created as
   drafts). The absence of releases after `v2026.03.03-312cd77` is the fix working, not neglect.

2. **CUSTODY-11 will mark superseded v1.x releases as pre-release in Phase 10.** Marking a release
   pre-release does not delete it and does not delete its assets — the tag, the download URLs and
   the digests above all remain valid. If the release page renders with a "Pre-release" badge, the
   pin is still good.

3. **The repository was renamed.** `fleizean/workflow-timer` 301-redirects to `fleizean/workflow`.
   Every URL here uses the current name directly rather than depending on GitHub continuing to
   honour that redirect. Note that `package.json`'s `name` field is still `workflow-timer` and
   **must stay that way** — it determines `%APPDATA%\workflow-timer\`, where every user's database
   lives (CUSTODY-02, `tests/app-identity.test.ts`).

---

## 2. Real user data (CUSTODY-07, D-03)

**Not in this repository, and never will be.** The owner's populated `krono.db` contains real
client names and real work notes. It is archived to a dated folder on the owner's machine, outside
both `%APPDATA%\workflow-timer\` and this working tree, by:

```bash
node tools/baseline/archive-real-db.mjs            # archive + extract schema
node tools/baseline/archive-real-db.mjs --self-test # exercise the guards, no real data needed
```

What *is* committed is the schema and nothing else:

| Artifact | Content |
|---|---|
| `tests/fixtures/v121-real-schema.sql` | the `sql` column of `sqlite_master` from the owner's real database — DDL only, zero rows |

The archive script refuses, by resolved-absolute-path containment, to write inside this repository
or inside the userData directory it reads from, and asserts its own output carries no `INSERT`
before writing it. The refusal is exercised by `--self-test`, not merely written down.

The archive location itself is deliberately **not** recorded here: this file is public.

---

## 3. Vendored capture assets

> **Reserved for plan `01-05`.** Fill in place. Expected content: each asset vendored under
> `tools/baseline/vendor/` for the offline baseline capture, with its source, version and SHA-256,
> so the capture is reproducible without network access.

_Not yet populated._

---

## 4. Capture provenance

> **Reserved for plan `01-06`.** Fill in place. Expected content: which launch path the baseline
> capture actually used (source tree, or the installed v1.2.1 obtained through section 1), the
> machine and OS it ran on, how the seeded dates were chosen, and the commit the capture was taken
> at. Phase 8 has to reproduce this capture exactly and this is where it will look.

_Not yet populated._

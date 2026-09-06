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

Phase 8 re-runs this capture and diffs the result. Everything it needs in order to launch the
*same* v1.2.1 the same way is here. Plan `01-05` filled in the launch path and the fixture policy;
plan `01-06` adds the machine, the OS build and the commit the capture was taken at.

### Launch path

`tools/baseline/probe-userdata.mjs` and `tools/baseline/capture.mjs` both read these rows. The
`Executable` row is parsed, so its shape matters: it is a single backticked value in the second
cell, and `%NAME%` environment variables in it are expanded at use.

| Field | Value |
|---|---|
| Launch path | `installed` |
| Executable | `%USERPROFILE%\workflow-timer-archive\app-v1.2.1\Workflow.exe` |
| Launch args | `--no-sandbox` |
| Payload source | the pinned `Workflow.Setup.1.2.1.exe` from section 1 |
| Resolved | plan `01-05`, 2026-09-06 |

**The installed-application path was chosen over run-from-source**, per research Open Question 2:
it is literally what users run, it needs no `better-sqlite3` native rebuild, and it therefore does
not depend on a toolchain this machine does not have (`better-sqlite3@9.6.0` fails to build here
with `MSB8020`, a missing ClangCL platform toolset — see plan `01-02`'s summary). It also means the
D-12 ordering barrier softens from an absolute to a preference: the capture no longer needs the
source tree's `better-sqlite3` to work.

**The installer is unpacked, not executed.** `Workflow.Setup.1.2.1.exe` is a one-click
electron-builder NSIS installer (`package.json` declares no `nsis` block, so `oneClick` and
`runAfterFinish` both take their default of `true`), and a one-click installer launches the
application when it finishes — including under `/S`. That launch would open the owner's real
`%APPDATA%\workflow-timer\krono.db` before the redirection probe had ever run, which is exactly the
disclosure this phase exists to prevent. The installer's payload is a 7-Zip stream appended to the
NSIS stub, so the identical application files are obtainable without executing anything:

```bash
# 7za.exe ships inside electron-builder's 7zip-bin dependency; no extra install is needed.
node_modules/7zip-bin/win/x64/7za.exe x \
  "$USERPROFILE/workflow-timer-archive/installers/Workflow.Setup.1.2.1.exe" \
  -o"$USERPROFILE\workflow-timer-archive\app-v1.2.1" -y
```

The extraction reports `There are data after the end of archive` — that is the NSIS stub and the
overlay either side of the payload, and is expected.

| Extracted file | Bytes | SHA-256 |
|---|---|---|
| `Workflow.exe` | 176,903,168 | `4fdd357c655edec7aaa9906ad19ff9a761e016dfa7993b74b528cc74e80c7f4f` |
| `resources/app.asar` | 21,543,827 | `c23e46b2089be581e585c2a1cb3035da274ebb778ed43fd8a20f446e41638de8` |

The extraction directory is outside this repository and is deliberately recorded relative to
`%USERPROFILE%` rather than as a literal path, for the same reason section 2 omits the archive
location: this file is public and the literal path carries the owner's Windows account name.

### The fixture-database redirection (assumption A1 — RESOLVED by execution)

`database/db.js:9-10` opens `path.join(app.getPath('userData'), 'krono.db')` at module load, and
`main.js:6` requires it at the top of the file, so no application-level hook runs early enough to
redirect it. Electron's `--user-data-dir` switch does, because
`ElectronMainDelegate::PreSandboxStartup()` overrides `chrome::DIR_USER_DATA` before the main
module is evaluated. Research read that from Electron v28.3.3's source but never executed it.

**It was executed on 2026-09-06 and it holds.** Launching the extracted `Workflow.exe` with
`--no-sandbox --user-data-dir=<tmp>` created `<tmp>/krono.db` and left the real database
byte-identical, mtime included. Re-verify at any time with:

```bash
node tools/baseline/probe-userdata.mjs
```

The probe is the capture driver's entry gate, not a comment: `tools/baseline/capture.mjs` calls it
before it is structurally able to take a screenshot, and `--skip-probe` is defined to exit non-zero
so the gate is provably capable of failing.

### Fixture seeding policy

> **Reserved for plan `01-05` task 2.** How the fixture's dates are derived from the run date.

### Capture run

> **Reserved for plan `01-06`.** The machine and OS build the capture ran on, and the commit it was
> taken at.

_Not yet populated._

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

A running v1.2.1 loads three third-party hosts, all of them live URLs:

| Host | Loaded by | What it decides |
|---|---|---|
| `cdn.tailwindcss.com` | `src/pages/*.html:17` | essentially every rendered pixel |
| `fonts.googleapis.com` | `src/styles/common.css:4-5` | which woff2 files are requested |
| `fonts.gstatic.com` | the two stylesheets above | Inter, and all 41 Material Symbols glyphs |

The Play CDN is the sharp edge. `https://cdn.tailwindcss.com?plugins=forms,container-queries`
currently 302s to `/3.4.17?plugins=forms@0.5.10,container-queries@0.1.1` — **verified by request on
2026-09-06**, which settles research assumption A7 by execution rather than by carry-forward — but
nothing holds it there. It also does not ship a stylesheet: it ships the JIT engine, which
generates CSS from the live DOM at runtime. A Phase 8 re-capture against a different build would
produce a diff, and that diff would be attributed to the rewrite.

So all eleven files are vendored under `tools/baseline/vendor/` and pinned by digest here.
`tools/baseline/capture.mjs` intercepts all three hosts, verifies each file's SHA-256 against this
table before fulfilling a request from it, and **fails closed** if a digest does not match. The
capture therefore needs no network at all.

Re-fetch (needs network; overwrites the files below, so re-record the digests if they move):

```bash
node tools/baseline/seed-baseline-db.mjs --fetch-vendor
node tools/baseline/seed-baseline-db.mjs --verify-vendor   # disk vs index.json vs this table
```

Google Fonts serves a different stylesheet per User-Agent. The fetch pins
`Chrome/120.0.0.0` — the Chromium version inside Electron 28.3.3, which is what the application
itself would send. Changing the UA changes the vendored CSS.

`tools/baseline/vendor/index.json` is the machine-readable form of this table (URL, file, bytes,
digest, fetch date, User-Agent); it is what `capture.mjs` resolves requests through, and
`--verify-vendor` cross-checks it against both the files on disk and the digests below.

Fetched **2026-09-06**, 1.8 MB total:

| Asset | Source URL | Bytes | SHA-256 |
|---|---|---|---|
| `tailwind.js` | <https://cdn.tailwindcss.com?plugins=forms,container-queries> | 418,973 | `a789ce5a73191759006b64a0c05f63afbf9aa43a86511bf798d688737429e60a` |
| `fonts-css/inter.css` | <https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap> | 9,884 | `5682df055e3bc3420ab5065274d8b14caeee02857f0af6c07d0995b8d6271077` |
| `fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2JL7SUc.woff2` | <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2JL7SUc.woff2> | 25,960 | `ca157063339ac4ad418f214f3abfed119b0798ab4d377386ce5c9e5a7a435ebd` |
| `fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7SUc.woff2` | <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7SUc.woff2> | 18,748 | `71d5ee93cc1e9f1d520a3a8b66456de18c7879d8df09d57fcd2eaff75fef0075` |
| `fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2ZL7SUc.woff2` | <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2ZL7SUc.woff2> | 11,232 | `6e9e020a25f9b56d418f2c085b1d3c09725a4da23fe693a5b463064606732190` |
| `fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1pL7SUc.woff2` | <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1pL7SUc.woff2> | 18,996 | `1be3448e292fbf05ffe176fe1e43f135013d50b1e7d324ad1a558f623d3bb6f6` |
| `fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7SUc.woff2` | <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7SUc.woff2> | 10,252 | `5c66f9e07e90c6d4ac4922cc68d60de26c17b1858e677fb5e603fce3952b3ff2` |
| `fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7SUc.woff2` | <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7SUc.woff2> | 85,068 | `34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956` |
| `fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2` | <https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2> | 48,256 | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `fonts-css/material-symbols.css` | <https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap> | 688 | `f229b149a663e9f469a61a8977d0327b9534b8952999be3a09e7b1a9e389d709` |
| `fonts/kJEPBvYX7BgnkSrUwT8OhrdQw4oELdPIeeII9v6oDMzBwG-RpA6RzaxHMPdY40KH8nGzv3fzfVJO1Q.woff2` | <https://fonts.gstatic.com/s/materialsymbolsoutlined/v369/kJEPBvYX7BgnkSrUwT8OhrdQw4oELdPIeeII9v6oDMzBwG-RpA6RzaxHMPdY40KH8nGzv3fzfVJO1Q.woff2> | 1,130,004 | `48d81a1cab89b4f3106081e85fff323b218cce76daf4c2c542503c8b1ccc6072` |

Two notes for a future reader:

- **The Material Symbols woff2 is 1.13 MB and is the whole variable font.** The application uses 41
  distinct icons and never touches the `FILL` axis, so a subset would be far smaller — but a subset
  is a *different* font, and the point of this directory is byte-fidelity to what v1.2.1 actually
  rendered. Subsetting belongs to the Phase 2 bundle-size work, not here.
- **`.gitattributes` marks `tools/baseline/vendor/**` as `-text`.** Without it the tree-wide
  `eol=crlf` rule would check `tailwind.js` and the two stylesheets out as CRLF, and every digest
  in the table above would fail on a fresh clone of a file nobody had touched.

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

Written by `tools/baseline/seed-baseline-db.mjs`. **Phase 8 must reproduce this exactly or its diff
means nothing**, which is why the policy is recorded here and not only in the script.

`database/db.js` reads the real system clock in `getTodaySessions()`, `getThisWeekTotal()`,
`getLastWeekTotal()` and `calculateCurrentStreak()`, so today's date is rendered into the output.
Research offered two responses: seed relative to the run date, or accept the drift and mask the date
strip. **Option (a), seed relative to the run date, was taken** — masking hides a region that the
parity diff would otherwise cover.

The non-obvious part is that "relative to the run date" is not enough on its own. `getThisWeekTotal`
and `getLastWeekTotal` slice by **calendar week, Monday to Sunday**, not by "N days ago". Seeding
`today-1` and `today-2` would put a different number of sessions inside the current week depending
on which weekday the capture ran on — none of them on a Monday, both on a Thursday. So the seed is
anchored to the week boundary on purpose:

| Rule | Consequence |
|---|---|
| All of the current week's work sits on **today**: 3 sessions, 14400 + 10800 + 5400 = **30,600 s** | This Week always contains exactly 3 sessions totalling 30,600 s |
| The historical block sits on **last week's Monday, Tuesday and Wednesday**, derived as `mondayOf(today) - 7 days + {0,1,2}` | always entirely inside "last week", never inside "this week"; Last Week is always 66,600 s |
| **Nothing** is seeded on `today-1` or `today-2` | those days cross the week boundary as the weekday changes |
| Pomodoro rows are seeded on **today only** | `getWeeklyPomodoroStats()` uses a rolling `[today-7, today]` window, not a calendar week |
| `daily_target` = 28,800 s; today's 30,600 s clears it; yesterday is empty | `calculateCurrentStreak()` returns **exactly 1** on every run date |

The streak of 1 is deliberate and doubly safe: `src/pages/index.html:719-729` starts the
`requestAnimationFrame` particle canvas at `streak > 10` and adds a pulsing CSS tier at `streak > 5`,
so at 1 there is no tier class and no animation clock to photograph. The capture masks
`#streakFireCanvas` as well; a fixture that never lights it is the sturdier of the two controls and
using both is correct.

Dates are formatted with the byte-for-byte copy of `database/db.js:16-18` `formatLocalDate` —
**local**, never `toISOString()`, or the fixture would be a day out for anyone whose offset from UTC
crosses midnight.

Every row passes `created_at` explicitly; `DEFAULT CURRENT_TIMESTAMP` would stamp the wall clock
into the fixture and two runs on the same date would then differ. Company and session names are
invented (`Northwind Fixture`, `Contoso Fixture`, `Fabrikam Fixture` — Microsoft's canonical
fictional companies, suffixed so no reader can mistake one for a real client), because every string
in the fixture is rendered into a PNG in this public repository. `Unassigned` is the one name that is
not invented: `initDatabase()` recreates it on every launch, so a fixture without it would be
silently mutated by the app the moment the capture began.

Verify all of the above without a database, a network or an app:

```bash
node tools/baseline/seed-baseline-db.mjs --self-test
```

### Capture run

> **Reserved for plan `01-06`.** The machine and OS build the capture ran on, and the commit it was
> taken at.

_Not yet populated._

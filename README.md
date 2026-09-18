# Workflow

<div align="center">

<img src="assets/banner.png" alt="Workflow" />

**Local-first work time tracking for Windows and macOS**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-lightgrey)](https://github.com/fleizean/workflow/releases/latest)

[What it does](#what-it-does) • [Install](#install) • [Your data](#your-data) • [Build from source](#build-from-source)

</div>

---

## What it does

Workflow tracks how long you work, for whom, and what you were doing — and keeps all of it on your
own machine. Start the timer, pick a company, write a note, save the session. There is no account,
no sync service and no server: the whole history is one SQLite file in your user data folder.

- **Timer** — start, pause, adjust by hand. Time that passes while the app is closed or the machine
  is asleep does not count as work.
- **Companies** — track per client, with an optional "a note is required" rule per company.
- **Daily target and streak** — set a target in hours; the streak counts consecutive days you met it.
- **Work history** — every session, grouped by week, filterable by company, date range and whether
  the target was met. Sessions can be renamed, re-attributed, edited or deleted.
- **Pomodoro** — work and break intervals with your own durations, a long break every *n* cycles,
  auto-start options, a sound and a system notification. It keeps counting while the window is
  hidden in the tray, and a completed pomodoro that has no note asks you what it was for.
- **Tray** — close to the tray and keep counting; one icon, one instance, whatever launches it.

**Offline by design.** Fonts, icons and sounds are inside the application bundle and a content
security policy forbids remote loads, so every screen renders with the network switched off. The one
exception is the version check described [below](#workflow-checks-github-for-a-newer-version), which
is optional and can be switched off.

## Install

Download the installer for your platform from the
[latest release](https://github.com/fleizean/workflow/releases/latest):

| Platform | File | Notes |
| --- | --- | --- |
| Windows 10/11, x64 | `*-x64-setup.exe` | The verified target |
| Windows 10/11, ARM64 | `*-arm64-setup.exe` | Built in CI, not runtime-verified |
| macOS, Intel | `*-x64.dmg` | Built in CI, not runtime-verified |
| macOS, Apple Silicon | `*-arm64.dmg` | Built in CI, not runtime-verified |

The builds are unsigned and unnotarised. On Windows, SmartScreen will warn you the first time.

### macOS: "App is damaged" or "Cannot be opened"

macOS quarantines downloads from an unsigned developer. To clear it:

```bash
xattr -dr com.apple.quarantine /Applications/Workflow.app
```

## Your data

Everything lives in one SQLite database in your user data folder:

| Platform | Folder |
| --- | --- |
| Windows | `%APPDATA%\workflow-timer\` |
| macOS | `~/Library/Application Support/workflow-timer/` |

Up to and including v1.2.1 the file in there was named `krono.db`. Workflow 2 can rename it to
`workflow.db` — look in the folder above to see which one your copy has. If it is still `krono.db`,
the rename has not happened on your machine and the rest of this section is about a day that has not
come yet.

**There is nothing for you to do either way.** The first time a version that performs the rename
starts, it finds your `krono.db`, flushes anything still sitting in its write-ahead log into the
file, and moves it to `workflow.db`. Your companies, sessions, notes and settings are the same rows
in the same database — only the name on disk changed. If the move cannot be completed for any
reason, Workflow stops and tells you so rather than starting an empty database; your file is left
exactly where it was.

Two things worth knowing:

- **Do not rename the file yourself while Workflow is running**, and do not copy `workflow.db` on
  its own. A Workflow database can have `-wal` and `-shm` files beside it holding sessions that are
  not yet in the main file; copying or renaming the main file alone quietly leaves them behind.
- **Going back to v1.2.1 after v2 has started will show an empty app.** v1.2.1 only knows the name
  `krono.db`, so it will not find `workflow.db` and will create a new, empty database next to it.
  Nothing of yours has been deleted. To go back, **with Workflow closed**, in this order:
  1. Open your user data folder. Everything below happens in there and nowhere else — the same
     file names exist in the `backups/` folder beside it, and working in the wrong one is how you
     lose the copy that would have saved you.
     - **Windows:** paste `%APPDATA%\workflow-timer` into the address bar of a File Explorer
       window, or into <kbd>Win</kbd>+<kbd>R</kbd>.
     - **macOS:** in Finder, **Go → Go to Folder** (<kbd>⇧</kbd><kbd>⌘</kbd><kbd>G</kbd>) and
       enter `~/Library/Application Support/workflow-timer`. That folder is hidden by default, so
       browsing to it will not work.
  2. Delete `krono.db`, `krono.db-wal` and `krono.db-shm` — all three, and the two sidecars even
     if they look empty. They belong to the blank database v1.2.1 just made. A `-wal` is not tied
     to the file it was written for, so one left behind here is applied to your real database the
     moment it takes that name, and empties it without any error.
  3. Rename `workflow.db` to `krono.db`. If `workflow.db-wal` and `workflow.db-shm` are there,
     rename those to `krono.db-wal` and `krono.db-shm` too — they hold sessions that are not yet
     in the main file.

  Do the deleting before the renaming. The other order is the one that loses everything.

Before it migrates anything, Workflow copies your database into a `backups/` folder beside it. And a
version of Workflow older than your database refuses to open it rather than writing to it — v1.2.1
has no such check, which is why going back has to be done in the order above.

#### Workflow checks GitHub for a newer version

About thirty seconds after you open it, and then once a day while it stays open, Workflow asks
GitHub for one small file: `https://fleizean.github.io/workflow/version.json`. That is the
only thing this application ever sends anywhere.

**What is sent:** an ordinary HTTPS `GET` for that fixed address. No query string, no cookie, no
account, no licence key, no `User-Agent`, no identifier of any kind. Nothing about you, your
machine, your companies, your notes or your tracked time leaves the app — not even which version you
are running. GitHub's servers see your IP address and the fact that this file was requested, exactly
as they would if you opened the page in a browser.

**What happens with the answer:** if the published version is newer than yours, the tray menu gains
an **Update available** line that opens the releases page in your browser. Nothing downloads on its
own and nothing installs itself. If the versions match, or the request fails for any reason, nothing
is said at all — no dialog, no badge, no retry storm. The check never delays the app opening or
closing, and with no network it fails silently.

**To switch it off entirely**, set `WORKFLOW_NO_UPDATE_CHECK` to any value before launching Workflow:

```powershell
setx WORKFLOW_NO_UPDATE_CHECK 1      # Windows, applies to new sessions
```

```bash
export WORKFLOW_NO_UPDATE_CHECK=1    # macOS
```

With it set, no network client is created and no request is made.

## Build from source

Requires **Node.js 24** (see `.nvmrc`). No Python, no MSVC and no Xcode command line tools:
`better-sqlite3` ships prebuilt N-API binaries and nothing here compiles native code.

```bash
git clone https://github.com/fleizean/workflow.git
cd workflow
npm ci
npm run dev
```

`npm run dev` starts electron-vite with hot reload and its own `workflow-timer-dev` user data
folder, so development never touches your real database.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app with hot reload |
| `npm start` | Run a production preview of the built app |
| `npm run lint` | ESLint over everything, including the architecture rules |
| `npm run typecheck` | `tsc --noEmit` for the Node and web projects |
| `npm test` | The vitest suite |
| `npm run build` | Typecheck, then build main, preload and renderer into `out/` |
| `npm run build:unpack` | Build and package into `dist/` without making an installer |
| `npm run build:win` / `build:win:arm64` | Windows installers |
| `npm run build:mac` / `build:mac:arm64` | macOS disk images |
| `npm run smoke:packaged` | Drive the packaged binary and check what it really does |
| `npm run parity:check` | Compare the v2 screens with the v1.2.1 baselines |
| `npm run matrix:check` | Lay the app out at five sizes and three display scales |
| `npm run offline:check` | Render every route with the network off |
| `npm run upgrade:check` | Migrate a populated v1.2.1 database and read it back through the app |
| `npm run instance:check` | Launch the packaged binary twice against one profile |

Installers land in `dist/`.

### Layout

```
workflow/
├── src/
│   ├── main/         Electron main process: ipc/ validates and calls one service,
│   │                 services/ hold the logic and know nothing of Electron,
│   │                 ports/ + adapters/ are how they reach the outside world
│   ├── preload/      the contextBridge surface - the only thing the renderer can call
│   ├── renderer/     React 18 SPA: app/ bootstrap and routes, features/<domain>/, components/
│   ├── lib/db/       Drizzle schema, migrations and repositories - the only SQL in the project
│   ├── shared/       types, zod schemas and the IPC contract both processes import
│   └── assets/       icons and the notification sound, bundled into the app
├── tests/            vitest: services, database, and the structural gates
├── tools/            baseline capture, the packaged smoke, CI assertions
├── baselines/        v1.2.1 screenshots and computed styles, and the v2 records
├── docs/             the GitHub Pages site
└── electron-builder.yml
```

## Contributing

Bug reports, ideas and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) describes the
layout rules and the gates a change has to pass.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- Icons: [Material Symbols](https://fonts.google.com/icons), self-hosted
- Font: [Inter](https://rsms.me/inter/) by Rasmus Andersson, self-hosted
- Database: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

---

<div align="center">

[⬆ Back to top](#workflow)

</div>

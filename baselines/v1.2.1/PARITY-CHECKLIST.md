# v1.2.1 Behaviour Parity Checklist

**Requirement:** CUSTODY-09. **Ticked by:** REL-06. **Gates:** SPA-14 (deletion of the legacy pages).

## Provenance

| Field | Value |
|---|---|
| Generator | `bash tools/baseline/inventory.sh` |
| Captured at commit | `22fe9a0fef3db6d122888e94f7025bf8504e589c` (branch `v2-restructure`) |
| Captured on | 2026-09-06 |
| Source of truth | `src/**/*.{html,js}`, `preload.js`, `main.js` — source text only. No database was opened and the application was not launched. |

| Count | Value | Artifact |
|---|---|---|
| `addEventListener` registration sites | **106** | `handlers.tsv` |
| Distinct `window.api.<name>` names called | **21** | derived from `api-calls.tsv` |
| Total `window.api.<name>` call sites | **67** | `api-calls.tsv` |
| APIs exposed by `preload.js` | **25** | `preload-surface.txt` |
| `ipcMain.handle` / `ipcMain.on` channels in `main.js` | **25** | `ipc-channels.txt` |

Re-run the generator in Phase 8 and diff `baselines/v1.2.1/` against the regenerated output. The
counts above are also asserted by `tests/inventory.test.ts`, which recomputes them from the live tree
on every CI run — so these artifacts cannot go stale while still looking authoritative.

## Where the parity workload is

Per-file `addEventListener` distribution. This is the size of the job, stated up front rather than
discovered in Phase 8:

| File | Sites |
|---|---|
| `src/pages/work-history.html` | 36 |
| `src/pages/index.html` | 27 |
| `src/pages/settings.html` | 24 |
| `src/pages/companies.html` | 15 |
| `src/renderer/bottom-nav.js` | 2 |
| `src/renderer/shared.js` | 1 |
| `src/renderer/titlebar.js` | 1 |
| `src/renderer/timer.js` | 0 |
| `src/pages/fragments/*.html` (4 files) | 0 — markup only, no script |
| **Total** | **106** |

`window.api` call sites by file: `settings.html` 25, `index.html` 20, `work-history.html` 13,
`companies.html` 6, `titlebar.js` 2, `shared.js` 1 — 67 in total.

## Corrections and findings recorded at capture time

### 1. The preload surface is 25 APIs, not 24

`.planning/research/PITFALLS.md` states 24. The live count is **25**
(`grep -c "^    [a-zA-Z0-9_]*:" preload.js`). Phase 6 (IPC-01) reproduces this surface and Phase 8
ticks against it, so 24 would understate the parity workload by one API. **25 is the denominator.**

The derived claim that five APIs are dead is unaffected and still holds: 25 exposed minus 20
exposed-and-called equals 5. Named explicitly, because "five are dead" is not actionable and a set is:

| Dead preload API (exposed, never called from `src/`) | Disposition |
|---|---|
| `getSessionsByDateCompany` | SPA-15 — remove, do not port |
| `getSessionsGrouped` | SPA-15 — remove, do not port |
| `getTodaySessions` | SPA-15 — remove, do not port |
| `getTodaysSessionsSummary` | SPA-15 — remove, do not port |
| `updateCompanyExcelConfig` | SPA-15 — remove, do not port |

### 2. `saveSetting` vs `setSetting` is a live defect (B4), not dead code

Exactly one name is called by the UI and **not** exposed by the bridge:

| Called by the UI | Exposed by `preload.js` | Result |
|---|---|---|
| `window.api.saveSetting` (`index.html:1434`, `index.html:1459`) | `setSetting` | `TypeError` at runtime — the write silently never happens |

Both call sites are on the Pomodoro toggle path, persisting `pomodoro_enabled`. In v1.2.1 the toggle
therefore updates the in-memory timer and `localStorage` but **never writes the setting to the
database**. This is finding B4 and it is **broken behaviour that must not be reimplemented
faithfully** — the correct parity outcome is a working persist, tracked by SET-03 / POMO-06.

### 3. The 106 `addEventListener` sites are not the whole behaviour surface

Six behaviours are attached through inline `onclick` attributes inside generated HTML strings and so
do **not** appear in `handlers.tsv`:

| File | Line | Attribute |
|---|---|---|
| `src/pages/companies.html` | 140 | `editCompany(<id>, '<company.name>')` |
| `src/pages/companies.html` | 145 | `deleteCompanyConfirm(<id>, '<company.name>', <sessionCount>)` |
| `src/pages/work-history.html` | 683 | `event.stopPropagation(); editSession(<id>)` |
| `src/pages/work-history.html` | 688 | `event.stopPropagation(); deleteSessionWithConfirm(<id>, '<session.name>')` |
| `src/renderer/titlebar.js` | 16 | `window.api.minimizeWindow()` |
| `src/renderer/titlebar.js` | 19 | `window.api.closeWindow()` |

The count stays 106 — that is what the grep measures and what the test pins. This note records what
106 does **not** cover, so Phase 8 does not read a fully ticked checklist as "everything was found".
The four interpolating attributes are the S2 injection hole (COMP-03, HIST-06); they are given rows
below so the behaviour is not lost together with the pages.

## How to use this checklist

- One row per **behaviour**, not per grep hit. A modal's close button and its click-outside-to-dismiss
  are several sites and one behaviour.
- `Reimplemented` = the behaviour exists in the new SPA. `Verified` = it was exercised and observed,
  not merely written.
- Every box starts unticked. Phase 8 earns the ticks. REL-06 requires all of them before SPA-14
  deletes `src/pages/*.html`.
- A blank `Req` means the row is UI plumbing with no requirement of its own; it still has to work.

---

## Shell — all screens (`bottom-nav.js`, `titlebar.js`, `shared.js`)

| # | Screen | Element | Event | Behavior | Req | Reimplemented | Verified |
|---|---|---|---|---|---|---|---|
| 1 | Shell | Bottom-nav link | click | Prevent default and navigate to the target page through the loading overlay | SPA-01, SPA-02 | [ ] | [ ] |
| 2 | Shell | Bottom-nav container | DOMContentLoaded | Build the nav from the current pathname and mark the active item | SPA-02 | [ ] | [ ] |
| 3 | Shell | Custom titlebar | DOMContentLoaded | Insert the frameless titlebar as the first child of `.app-container` when one exists | | [ ] | [ ] |
| 4 | Shell | Titlebar minimize / close | click (inline `onclick`) | `window.api.minimizeWindow()` / `window.api.closeWindow()` — window controls; close must actually quit rather than re-hide | IPC-08 | [ ] | [ ] |
| 5 | Shell | Toast close button | click | Fade out and remove; the toast also self-dismisses on a timer | SPA-04 | [ ] | [ ] |
| 6 | Shell | Alert modal close / backdrop | click | Dismiss the shared alert. In v1.2.1 every page carries its own copy of `showAlert` / `createModernModal` | SPA-03, SPA-04 | [ ] | [ ] |
| 7 | Shell | Page navigation | — | `window.api.navigateTo({ page })` loads another HTML file. **Not ported** — the channel is deleted with its path-traversal hole (S1) and replaced by client-side routing | IPC-02, SPA-01 | [ ] | [ ] |

## Home / Timer (`src/pages/index.html` — 27 handler sites, 20 API call sites)

| # | Screen | Element | Event | Behavior | Req | Reimplemented | Verified |
|---|---|---|---|---|---|---|---|
| 8 | Home | Play/pause button | click | Toggle run/pause, swap the `play_arrow` / `pause` icon, show or hide the status badge, persist timer state | TIMER-01 | [ ] | [ ] |
| 9 | Home | Adjust button | click | Open the manual time-adjust modal | TIMER-01 | [ ] | [ ] |
| 10 | Home | Adjust presets (`.adjust-btn`) | click | Add `data-seconds` to elapsed and persist | TIMER-01 | [ ] | [ ] |
| 11 | Home | Apply-manual-minutes button | click | Add N minutes to elapsed, clear the input, persist | TIMER-01 | [ ] | [ ] |
| 12 | Home | Adjust modal close / backdrop | click | Dismiss without applying | SPA-03 | [ ] | [ ] |
| 13 | Home | Save button | click | Refuse with "No time to save!" when elapsed is 0; otherwise open the save-session modal populated with companies | TIMER-02 | [ ] | [ ] |
| 14 | Home | Confirm-save button | click | `saveSession` with name, duration, company and note for the selected date, then reset the timer. **v1.2.1 demands a note for every company regardless of the company's note-required flag** — B11; the correct behaviour is per-company | TIMER-02, TIMER-03, TIMER-04 | [ ] | [ ] |
| 15 | Home | Save-session name input | keypress `Enter` | Forward Enter to the confirm-save button | TIMER-02 | [ ] | [ ] |
| 16 | Home | Save modal close / backdrop | click | Dismiss without saving | SPA-03 | [ ] | [ ] |
| 17 | Home | Reset button | click | Open the "Reset Timer?" confirmation | TIMER-06 | [ ] | [ ] |
| 18 | Home | Confirm-reset button | click | Pause, zero elapsed, restore the play icon, hide the focused badge, persist, dismiss, and toast success | TIMER-06 | [ ] | [ ] |
| 19 | Home | Cancel-reset / backdrop | click | Dismiss without resetting | TIMER-06, SPA-03 | [ ] | [ ] |
| 20 | Home | Date-picker button | click | Open the date modal with today / yesterday / −2d / −3d preselected against the current working date | TIMER-04 | [ ] | [ ] |
| 21 | Home | Date presets (`.date-opt`) | click | Set the working date by day offset, re-render the header, reload that day's totals | TIMER-04 | [ ] | [ ] |
| 22 | Home | Custom date input | change | Set the working date from the ISO value and reload that day | TIMER-04 | [ ] | [ ] |
| 23 | Home | Date modal close / backdrop | click | Dismiss, keeping the current date | SPA-03 | [ ] | [ ] |
| 24 | Home | Pomodoro toggle | click | Enabling re-reads the six pomodoro settings from the database before entering pomodoro mode; disabling leaves it. Persists `pomodoro_enabled` — **through the broken `saveSetting` name, so the write never lands** — then refreshes the pomodoro UI and re-renders elapsed | POMO-06, SET-03, CORE-14 | [ ] | [ ] |
| 25 | Home | Logged-today card | click | Navigate to Work History | SPA-01 | [ ] | [ ] |
| 26 | Home | Streak card | click | **Debug leftover:** cycles a fake streak through 6 / 15 / 25, applies the tier visual effects and writes `N days (TEST)` into the UI. **Must not be reimplemented** — the card shows real data | TIMER-09 | [ ] | [ ] |
| 27 | Home | Daily-goal alert close / backdrop | click | Dismiss the goal-reached celebration | TIMER-05 | [ ] | [ ] |
| 28 | Home | Page-local alert close / backdrop | click | Dismiss this page's copy of the alert modal | SPA-04 | [ ] | [ ] |
| 29 | Home | Timer tick | (no listener) | `timer.onUpdate` re-renders elapsed and persists on every tick. v1.2.1 persists a start timestamp to `localStorage`, which is how time while closed or asleep gets credited | CORE-04, CORE-05, CORE-06, CORE-07, DATA-10 | [ ] | [ ] |

## Work History (`src/pages/work-history.html` — 36 handler sites, 13 API call sites)

| # | Screen | Element | Event | Behavior | Req | Reimplemented | Verified |
|---|---|---|---|---|---|---|---|
| 30 | History | Session group card | click | Expand/collapse the day's detail section and rotate the chevron; clicks landing on a button are ignored | HIST-01 | [ ] | [ ] |
| 31 | History | Back button | click | Navigate to Home | SPA-01 | [ ] | [ ] |
| 32 | History | Companies button | click | Navigate to Companies | SPA-01 | [ ] | [ ] |
| 33 | History | Session card edit / delete buttons | click (inline `onclick`) | `event.stopPropagation()`, then open the edit or delete-confirm modal for that session. The session name is interpolated into the attribute — S2 | HIST-04, HIST-06 | [ ] | [ ] |
| 34 | History | Save-edit-session button | click | `updateSession` with the edited name, duration, company and note, honouring note-required | HIST-04 | [ ] | [ ] |
| 35 | History | Edit modal close / backdrop | click | Dismiss without saving | SPA-03 | [ ] | [ ] |
| 36 | History | Confirm-delete-session button | click | `deleteSession`, then reload the list | HIST-04 | [ ] | [ ] |
| 37 | History | Cancel-delete / backdrop | click | Dismiss without deleting | SPA-03 | [ ] | [ ] |
| 38 | History | Add-session FAB | click | Load companies and open the manual add-session modal | HIST-04 | [ ] | [ ] |
| 39 | History | New-session date button | click | Open the date picker for the session being added | HIST-04, TIMER-04 | [ ] | [ ] |
| 40 | History | New-session quick date / custom date | click / change | Set the new session's date by day offset or from the ISO value | HIST-04, TIMER-04 | [ ] | [ ] |
| 41 | History | Save-new-session button | click | `saveSession` for a manually entered past session | HIST-04, TIMER-04 | [ ] | [ ] |
| 42 | History | Add modal close / backdrop | click | Dismiss without saving | SPA-03 | [ ] | [ ] |
| 43 | History | Filter button | click | Load companies and open the filter modal seeded from `localStorage.sessionFilters` | HIST-03 | [ ] | [ ] |
| 44 | History | Apply-filters button | click | Persist companies, date range, duration range, goal filter, sort field and sort order to `localStorage`, then reload the list | HIST-02, HIST-03 | [ ] | [ ] |
| 45 | History | Clear-filters button | click | Remove the saved filters and reload | HIST-03 | [ ] | [ ] |
| 46 | History | Goal-filter radios | change | Restyle the selected radio label (pure presentation) | | [ ] | [ ] |
| 47 | History | Filter modal close / backdrop | click | Dismiss without applying | SPA-03 | [ ] | [ ] |
| 48 | History | Export-Day-End button | click | `previewDayEnd` for the chosen date and render the preview modal before anything is sent | EXPORT-01, EXPORT-02 | [ ] | [ ] |
| 49 | History | Change-export-date button | click | Open the export date modal | EXPORT-01 | [ ] | [ ] |
| 50 | History | Export quick date / custom date | click / change | Reselect the export date and re-run the preview | EXPORT-03, EXPORT-05 | [ ] | [ ] |
| 51 | History | Confirm-export button | click | Refuse an empty entry set with an error toast; otherwise `exportDayEnd`, disable the button with a spinner, and report the outcome | EXPORT-06, CORE-15 | [ ] | [ ] |
| 52 | History | Export modal close / cancel / backdrop | click | Dismiss without exporting | SPA-03 | [ ] | [ ] |
| 53 | History | Page-local alert close / backdrop | click | Dismiss this page's copy of the alert modal | SPA-04 | [ ] | [ ] |
| 54 | History | Session list render | (no listener) | Sessions are bucketed into This Week / Last Week / Older and the list is built by repeated `innerHTML +=` | HIST-01, HIST-05 | [ ] | [ ] |

## Settings (`src/pages/settings.html` — 24 handler sites, 25 API call sites)

| # | Screen | Element | Event | Behavior | Req | Reimplemented | Verified |
|---|---|---|---|---|---|---|---|
| 55 | Settings | Back button | click | Navigate to Home | SPA-01 | [ ] | [ ] |
| 56 | Settings | About button | click | `window.open` the GitHub repository — leaves the app, so the new shell must deny in-app navigation and hand it to the OS browser | IPC-09 | [ ] | [ ] |
| 57 | Settings | Daily-target button | click | Open the daily work-hour target picker | SET-01 | [ ] | [ ] |
| 58 | Settings | Target preset buttons | click | Select a preset daily target | SET-01 | [ ] | [ ] |
| 59 | Settings | Apply-custom-time button | click | Apply a manually typed daily target | SET-01 | [ ] | [ ] |
| 60 | Settings | Time modal close / backdrop | click | Dismiss without changing the target | SPA-03 | [ ] | [ ] |
| 61 | Settings | Save-settings button | click | Write 13 settings through `setSetting`: `daily_target`, `goal_notification`, `exclude_weekends_from_streak`, the six `pomodoro_*` keys, `script_url`, `export_half_hour_precision` | SET-01, SET-02, SET-05 | [ ] | [ ] |
| 62 | Settings | Delete-all-data button | click | Open the destructive confirmation. **Bound through `document.querySelector('.mt-8.mb-8 button')`** — a Tailwind spacing tweak silently detaches the delete-all-data handler | SET-04, SPA-13 | [ ] | [ ] |
| 63 | Settings | Confirm-delete-all button | click | `deleteAllSessions`, then show a result modal | SET-04 | [ ] | [ ] |
| 64 | Settings | Delete-all result close / backdrop | click | Dismiss the result modal | SPA-03 | [ ] | [ ] |
| 65 | Settings | Cancel-delete-all / backdrop | click | Dismiss without deleting | SET-04 | [ ] | [ ] |
| 66 | Settings | Setup-instructions button | click | Open the Google Sheets setup instructions modal | EXPORT-02 | [ ] | [ ] |
| 67 | Settings | Instructions modal close / backdrop | click | Dismiss | SPA-03 | [ ] | [ ] |
| 68 | Settings | Pomodoro-enabled toggle | change | Show or hide the duration block and call `saveSettings()` — this is the source of the spurious "settings saved" dialog | SET-03 | [ ] | [ ] |
| 69 | Settings | Pomodoro duration inputs (work, short break, long break, sessions-until-long-break) | input | Live-update the `N min` display label beside each control | SET-02 | [ ] | [ ] |
| 70 | Settings | Page-local alert close / backdrop | click | Dismiss this page's copy of the alert modal | SPA-04 | [ ] | [ ] |
| 71 | Settings | Settings load | (no listener) | On init, read all 13 settings through `getSetting` and populate every control | SET-01, SET-02, SET-05 | [ ] | [ ] |

## Companies (`src/pages/companies.html` — 15 handler sites, 6 API call sites)

| # | Screen | Element | Event | Behavior | Req | Reimplemented | Verified |
|---|---|---|---|---|---|---|---|
| 72 | Companies | Back button | click | Navigate to Home | SPA-01 | [ ] | [ ] |
| 73 | Companies | Add-company FAB | click | Open the create-company modal | COMP-01 | [ ] | [ ] |
| 74 | Companies | Save-company button | click | `createCompany` with the name and the note-required flag, then reload the list | COMP-01, COMP-02 | [ ] | [ ] |
| 75 | Companies | Create name input | keypress `Enter` | Forward Enter to the save-company button | COMP-01 | [ ] | [ ] |
| 76 | Companies | Create modal close / backdrop | click | Dismiss without creating | SPA-03 | [ ] | [ ] |
| 77 | Companies | Company card edit / delete buttons | click (inline `onclick`) | Open the edit or delete-confirm modal. The company name is interpolated into the attribute with only `'` escaped — S2 injection hole | COMP-03 | [ ] | [ ] |
| 78 | Companies | Update-company button | click | `updateCompany` with the edited name and note-required flag | COMP-01, COMP-02 | [ ] | [ ] |
| 79 | Companies | Edit name input | keypress `Enter` | Forward Enter to the update-company button | COMP-01 | [ ] | [ ] |
| 80 | Companies | Edit modal close / backdrop | click | Dismiss without saving | SPA-03 | [ ] | [ ] |
| 81 | Companies | Confirm-delete-company button | click | `deleteCompany`, then reload the list | COMP-04 | [ ] | [ ] |
| 82 | Companies | Cancel-delete / backdrop | click | Dismiss without deleting | COMP-04, SPA-03 | [ ] | [ ] |
| 83 | Companies | Delete confirmation copy | (no listener) | The warning states the session count for the company, passed in from the list render rather than from the delete query | COMP-04, COMP-05 | [ ] | [ ] |
| 84 | Companies | Page-local alert close / backdrop | click | Dismiss this page's copy of the alert modal | SPA-04 | [ ] | [ ] |

## Preload surface — the IPC contract Phase 6 must reproduce

All 25 names, from `preload-surface.txt`. IPC-01 requires every capability except navigation to have
a counterpart in the new typed bridge.

| # | Preload API | Channel | Called from `src/` | Behavior | Req | Reimplemented | Verified |
|---|---|---|---|---|---|---|---|
| 85 | `saveSession` | `save-session` | yes (2) | Persist a completed session | TIMER-02, IPC-01 | [ ] | [ ] |
| 86 | `getSessions` | `get-sessions` | yes (3) | Read all sessions | HIST-01, IPC-01 | [ ] | [ ] |
| 87 | `getSessionsByDate` | `get-sessions-by-date` | yes (1) | Read one day's sessions | HIST-01, IPC-01 | [ ] | [ ] |
| 88 | `updateSession` | `update-session` | yes (1) | Edit a past session | HIST-04, IPC-01 | [ ] | [ ] |
| 89 | `deleteSession` | `delete-session` | yes (1) | Delete one session | HIST-04, IPC-01 | [ ] | [ ] |
| 90 | `deleteAllSessions` | `delete-all-sessions` | yes (1) | Destructive wipe from Settings | SET-04, IPC-01 | [ ] | [ ] |
| 91 | `createCompany` | `create-company` | yes (1) | Create a company | COMP-01, IPC-01 | [ ] | [ ] |
| 92 | `getCompanies` | `get-companies` | yes (6) | List companies | COMP-01, IPC-01 | [ ] | [ ] |
| 93 | `getCompany` | `get-company` | yes (1) | Read one company, including the note-required flag | COMP-02, IPC-01 | [ ] | [ ] |
| 94 | `updateCompany` | `update-company` | yes (1) | Rename a company or retoggle note-required | COMP-01, COMP-02, IPC-01 | [ ] | [ ] |
| 95 | `updateCompanyExcelConfig` | `update-company-excel-config` | **no** | Dead — remove, do not port | SPA-15 | [ ] | [ ] |
| 96 | `deleteCompany` | `delete-company` | yes (1) | Delete a company | COMP-04, IPC-01 | [ ] | [ ] |
| 97 | `getSessionsGrouped` | `get-sessions-grouped` | **no** | Dead — remove, do not port | SPA-15 | [ ] | [ ] |
| 98 | `getSessionsByDateCompany` | `get-sessions-by-date-company` | **no** | Dead — remove, do not port | SPA-15 | [ ] | [ ] |
| 99 | `getSetting` | `get-setting` | yes (27) | Read one setting by key | SET-01, IPC-01 | [ ] | [ ] |
| 100 | `setSetting` | `set-setting` | yes (12) | Write one setting by key | SET-01, IPC-01 | [ ] | [ ] |
| 101 | `getWeekTotal` | `get-week-total` | yes (1) | Weekly total for the home card | CORE-08, IPC-01 | [ ] | [ ] |
| 102 | `getCurrentStreak` | `get-current-streak` | yes (1) | Current streak for the home card | CORE-08, TIMER-09, IPC-01 | [ ] | [ ] |
| 103 | `getTodaySessions` | `get-today-sessions` | **no** | Dead — remove, do not port | SPA-15 | [ ] | [ ] |
| 104 | `getTodaysSessionsSummary` | `get-todays-sessions-summary` | **no** | Dead — remove, do not port | SPA-15 | [ ] | [ ] |
| 105 | `previewDayEnd` | `preview-day-end` | yes (1) | Build the export preview | EXPORT-02, IPC-01 | [ ] | [ ] |
| 106 | `exportDayEnd` | `export-day-end` | yes (1) | Perform the export | EXPORT-01, EXPORT-06, IPC-01 | [ ] | [ ] |
| 107 | `navigateTo` | `navigate` | yes (1) | `mainWindow.loadFile(userSuppliedPath)`. **Deliberately not ported** — the channel is deleted together with its path-traversal hole | IPC-02 | [ ] | [ ] |
| 108 | `minimizeWindow` | `minimize-window` | yes (1) | Minimize the window | IPC-01 | [ ] | [ ] |
| 109 | `closeWindow` | `close-window` | yes (1) | Close the window — in v1.2.1 this re-hides to the tray rather than quitting | IPC-08 | [ ] | [ ] |
| 110 | `saveSetting` | — | yes (2) | **Called but never exposed (B4).** `index.html:1434` and `:1459` write `pomodoro_enabled` through a name the bridge does not have, so the write silently never happens. Parity means fixing it, not reproducing it | SET-03, POMO-06 | [ ] | [ ] |

The 25 exposed APIs (#85–#109) map one-to-one onto the 25 `ipcMain` channels in `ipc-channels.txt`.
Row #110 is a demand-side name with no supply side; it is not part of the 25.

## Exit gate

REL-06 is satisfied when every `Reimplemented` and every `Verified` box above is ticked, except the
rows explicitly marked *do not port* (#95, #97, #98, #103, #104 — SPA-15) and the rows marked
*deliberately not ported* (#7, #107 — IPC-02), which are ticked by confirming the capability is
**absent**. Only then does SPA-14 delete `src/pages/*.html` in its own commit.

# v1.2.1 Behaviour Parity Checklist

**Requirement:** CUSTODY-09. **Ticked by:** REL-06. **Gates:** SPA-14 (deletion of the legacy pages).

## Provenance

| Field | Value |
|---|---|
| Generator | `bash tools/baseline/inventory.sh` |
| Captured at commit | `22fe9a0fef3db6d122888e94f7025bf8504e589c` (branch `v2-restructure`) |
| Captured on | 2026-09-06 |
| Source of truth | `src/**/*.{html,js}`, `preload.js`, `main.js` — source text only. No database was opened and the application was not launched. |
| Moved 2026-09-13 | Phase 7 moved the v1.2.1 renderer from `src/pages/` and `src/renderer/*.js` to `legacy/pages/` and `legacy/renderer/`, and `src/styles/` to `legacy/styles/`. Every `src/…` citation below names the file as v1.2.1 shipped it; read it at its `legacy/…` path in this tree. The counts are unchanged — the four deleted page fragments contributed none of them. |
| Deleted 2026-09-16 | Slice 08-F deleted `legacy/`, `main.js`, `preload.js` and `database/db.js` (SPA-14). Every `src/…` and `legacy/…` citation in this document still resolves - git has the files. `MANIFEST.md` section 5 has the one-line recipe for reading any of them, and the table of what each guard that pinned them reads now. The counts below were regenerated from git history after the deletion and are byte-identical. |

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

### Marks, as slice 08-F filled them in

| Mark | Meaning |
|---|---|
| `[x]` under Reimplemented | the behaviour exists in the SPA. Where what it does differs from v1.2.1, the Evidence cell says how and why. |
| `[-]` under Reimplemented | **deliberately absent**, and the row is ticked by confirming the absence rather than the presence - the Google Sheets export the owner removed, the `navigate` channel deleted with its path-traversal hole, and the streak card's debug leftover. |
| `[x]` under Verified | exercised and observed by something that runs: a test in `tests/`, a check in the packaged smoke, or the four-route capture behind `baselines/v1.2.1/VISUAL-PARITY-DIFF.md`. The Evidence cell names which. |
| `[ ]` under Verified | **not exercised**, and the Evidence cell says what does exist and what is left. This is never a shrug: it is the UAT list. |

### Where it stands

| | Count |
|---|---|
| Reimplemented, present | 96 |
| Reimplemented, deliberately absent and confirmed absent | 14 |
| **Reimplemented, total settled** | **110 / 110** |
| Verified - exercised and observed | 52 |
| Verified - not exercised | 58 |

**The 58 are one shape, not an assortment.** Every one of them is a pointer landing on a control:
a press, a dismissal, a typed field, a backdrop click. This repository has **no jsdom and renders no
component in any test, by decision** (`08-SCOPE.md`), so there is nothing here that can press a
button. What each of those rows *can* be held to - the arithmetic, the wording, the query keys, the
class names against compiled CSS, the refusal below IPC - is held to it, and the Evidence cell names
the file. What is left in all 58 cases is a human using the app.

Three rows are worth reading on their own rather than as part of that 58: **#56** is the only row
in the document that is *not fully met* - About denies in-app navigation but does not hand the URL
to the OS browser, because no channel opens one - and **#98, #103, #104** record that Phase 1's
*do not port* disposition was revised during implementation, so the five names actually dropped are
not the five this document predicted.

---

## Shell — all screens (`bottom-nav.js`, `titlebar.js`, `shared.js`)

| # | Screen | Element | Event | Behavior | Req | Reimplemented | Verified | Evidence, or why not |
|---|---|---|---|---|---|---|------|
| 1 | Shell | Bottom-nav link | click | Prevent default and navigate to the target page through the loading overlay | SPA-01, SPA-02 | [x] | [x] | `BottomNav` renders a `NavLink` per route; smoke *changing route loaded no document, and did change the page in place*. **Deviation:** no loading overlay - a route change is one React commit, so there is nothing left to cover. |
| 2 | Shell | Bottom-nav container | DOMContentLoaded | Build the nav from the current pathname and mark the active item | SPA-02 | [x] | [x] | `BottomNav` marks the active item from the current path. Rendered in all 20 captures behind `VISUAL-PARITY-DIFF.md`. |
| 3 | Shell | Custom titlebar | DOMContentLoaded | Insert the frameless titlebar as the first child of `.app-container` when one exists | | [x] | [x] | `AppShell` renders `TitleBar` as its first child. Present in all 20 captures. |
| 4 | Shell | Titlebar minimize / close | click (inline `onclick`) | `window.api.minimizeWindow()` / `window.api.closeWindow()` — window controls; close must actually quit rather than re-hide | IPC-08 | [x] | [x] | `window:hide` and `app:quit`. Smoke: *a system close hides the window instead of ending the app*, *with no tray to hide to the window really closes, so the app stays quittable* (WR-03), *quitting lets the window go instead of re-hiding it*. **IPC-08 closed** - v1.2.1's close only ever re-hid. |
| 5 | Shell | Toast close button | click | Fade out and remove; the toast also self-dismisses on a timer | SPA-04 | [x] | [ ] | `ToastStack`: a close button, and auto-dismiss at v1.2.1's own 3000 ms. **Not exercised** - no test renders a component and the capture raises no toast. Closes by raising one in the running app. |
| 6 | Shell | Alert modal close / backdrop | click | Dismiss the shared alert. In v1.2.1 every page carries its own copy of `showAlert` / `createModernModal` | SPA-03, SPA-04 | [x] | [ ] | One `AlertDialog` over the shared `Modal`, mounted once in `AppShell`; close button, backdrop and Escape are one answer. **Not exercised** - as row 5. |
| 7 | Shell | Page navigation | — | `window.api.navigateTo({ page })` loads another HTML file. **Not ported** — the channel is deleted with its path-traversal hole (S1) and replaced by client-side routing | IPC-02, SPA-01 | [-] | [x] | Confirmed **absent**. `tests/ipc-parity.test.ts` finds no channel, no event and no string literal naming it anywhere in the v2 source but the `will-navigate` guard. `HashRouter` changes route with no main-process involvement, so the path-traversal hole (S1) has nothing to reach. |

## Home / Timer (`src/pages/index.html` — 27 handler sites, 20 API call sites)

| # | Screen | Element | Event | Behavior | Req | Reimplemented | Verified | Evidence, or why not |
|---|---|---|---|---|---|---|------|
| 8 | Home | Play/pause button | click | Toggle run/pause, swap the `play_arrow` / `pause` icon, show or hide the status badge, persist timer state | TIMER-01 | [x] | [ ] | `TimerControls` to `useTimerCommands` start/pause; the icon, the badge and the digits are `describeWorkDial`'s, run in `tests/timer-screen.test.ts`. Persistence is main's (`tests/timer-service.test.ts`, packaged `timer` case). **The press itself is not exercised.** |
| 9 | Home | Adjust button | click | Open the manual time-adjust modal | TIMER-01 | [x] | [ ] | `AdjustTimeForm` in the shared `Modal`. Not exercised. |
| 10 | Home | Adjust presets (`.adjust-btn`) | click | Add `data-seconds` to elapsed and persist | TIMER-01 | [x] | [ ] | **Deviation (08-C):** the six +/-30, +/-5, +/-1 steps are ported, but they change the duration of the session about to be written, not the counted clock - main has no channel that adds seconds to the accumulator, deliberately, because a channel that invents work is what this milestone exists to close. The arithmetic runs in `tests/timer-screen.test.ts`; the press is not exercised. |
| 11 | Home | Apply-manual-minutes button | click | Add N minutes to elapsed, clear the input, persist | TIMER-01 | [x] | [ ] | As row 10: the manual-minutes field applies to the pending session's duration, not to the clock. Not exercised. |
| 12 | Home | Adjust modal close / backdrop | click | Dismiss without applying | SPA-03 | [x] | [ ] | Shared `Modal`: dismiss button, backdrop and Escape. Not exercised. |
| 13 | Home | Save button | click | Refuse with "No time to save!" when elapsed is 0; otherwise open the save-session modal populated with companies | TIMER-02 | [x] | [x] | **Deviation:** v2 disables SAVE while nothing is counted instead of accepting the press and refusing it with *No time to save!*. The refusal is the same; the control says so before it is pressed. **Observed:** the capture records that button at `opacity: 0.4` with zero counted time (`VISUAL-PARITY-DIFF.md`). The populated path is not exercised. |
| 14 | Home | Confirm-save button | click | `saveSession` with name, duration, company and note for the selected date, then reset the timer. **v1.2.1 demands a note for every company regardless of the company's note-required flag** — B11; the correct behaviour is per-company | TIMER-02, TIMER-03, TIMER-04 | [x] | [ ] | `timer:stopAndSave` writes the session and clears the accumulator in **one transaction** (WR-06) - two invokes cannot be atomic, and either order loses or duplicates a session on a kill. **B11 closed:** the note is demanded per company, refused below IPC (`tests/sessions-service.test.ts`). The form's own path is not exercised. |
| 15 | Home | Save-session name input | keypress `Enter` | Forward Enter to the confirm-save button | TIMER-02 | [x] | [ ] | Native form semantics rather than a keypress listener: `SaveSessionForm` is a `<form onSubmit>` with a `type="submit"` button, so Enter in the name field submits. Not exercised. |
| 16 | Home | Save modal close / backdrop | click | Dismiss without saving | SPA-03 | [x] | [ ] | Shared `Modal`. Not exercised. |
| 17 | Home | Reset button | click | Open the "Reset Timer?" confirmation | TIMER-06 | [x] | [ ] | One confirm that names the amount - *Discard 02h 13m?*. The button is disabled while nothing is counted (row 13's deviation), observed at `opacity: 0.4`; the dialog itself is not exercised. |
| 18 | Home | Confirm-reset button | click | Pause, zero elapsed, restore the play icon, hide the focused badge, persist, dismiss, and toast success | TIMER-06 | [x] | [ ] | **B5 closed:** v1.2.1 threw on `focusedBadge` - an identifier declared nowhere - before `modal.remove()`, so the dialog stayed open over a timer that had already been zeroed. No such variable exists and the confirm is the shared `AlertDialog`. `timer:reset` is exercised in `tests/timer-service.test.ts` and in the packaged smoke; the dialog is not. |
| 19 | Home | Cancel-reset / backdrop | click | Dismiss without resetting | TIMER-06, SPA-03 | [x] | [ ] | Dismissing answers nothing: only the confirm button discards. Not exercised. |
| 20 | Home | Date-picker button | click | Open the date modal with today / yesterday / −2d / −3d preselected against the current working date | TIMER-04 | [x] | [ ] | `DatePickerForm`, four quick dates preselected against the current working date. Not exercised. |
| 21 | Home | Date presets (`.date-opt`) | click | Set the working date by day offset, re-render the header, reload that day's totals | TIMER-04 | [x] | [ ] | The picked day is the day the save dialog opens on **and** the day the row is written on. **B10 closed:** v1.2.1 changed which day the Logged card measured and then saved with `getCurrentDate()` regardless. Not exercised. |
| 22 | Home | Custom date input | change | Set the working date from the ISO value and reload that day | TIMER-04 | [x] | [ ] | **B9 closed:** the custom date no longer comes from `toISOString()`, which names yesterday west of Greenwich (`tests/renderer-format.test.ts` carries the control, asserted where the host zone is actually west of UTC). Not exercised. |
| 23 | Home | Date modal close / backdrop | click | Dismiss, keeping the current date | SPA-03 | [x] | [ ] | Shared `Modal`. Not exercised. |
| 24 | Home | Pomodoro toggle | click | Enabling re-reads the six pomodoro settings from the database before entering pomodoro mode; disabling leaves it. Persists `pomodoro_enabled` — **through the broken `saveSetting` name, so the write never lands** — then refreshes the pomodoro UI and re-renders elapsed | POMO-06, SET-03, CORE-14 | [x] | [x] | **B4 closed:** the write goes through `settings:update`, a channel that exists - v1.2.1 called `window.api.saveSetting`, which `preload.js` never exposed, so the write silently never happened (`tests/ipc-parity.test.ts`). `tests/renderer-structure.test.ts` holds exactly one file writing `pomodoroEnabled` and exactly one sending `timer:setMode`, and both screens that carry a toggle through that file. **CB-1 closed:** the toggle no longer calls `reset()`, so switching mode keeps every counted second. |
| 25 | Home | Logged-today card | click | Navigate to Work History | SPA-01 | [x] | [ ] | The Logged card links to Work History, and `cursor-pointer` is on that card alone - v1.2.1 put it on all three while only one navigated (08-C). Not exercised. |
| 26 | Home | Streak card | click | **Debug leftover:** cycles a fake streak through 6 / 15 / 25, applies the tier visual effects and writes `N days (TEST)` into the UI. **Must not be reimplemented** — the card shows real data | TIMER-09 | [-] | [x] | **TIMER-09, confirmed absent.** v1.2.1's streak card cycled a fake 6 / 15 / 25 and wrote `N days (TEST)` into the label. The card has no click handler, no `(TEST)` string exists anywhere in the renderer, and `tests/timer-screen.test.ts` runs the real tiers against real values. |
| 27 | Home | Daily-goal alert close / backdrop | click | Dismiss the goal-reached celebration | TIMER-05 | [x] | [ ] | The shared `AlertDialog`, raised only on the transition, so re-entering Home on a day already met says nothing. **Deviation (08-C):** English rather than Turkish, and it does not auto-close after six seconds. Not exercised. |
| 28 | Home | Page-local alert close / backdrop | click | Dismiss this page's copy of the alert modal | SPA-04 | [x] | [ ] | One shared alert for the whole app instead of a copy of `showAlert` per page. Not exercised. |
| 29 | Home | Timer tick | (no listener) | `timer.onUpdate` re-renders elapsed and persists on every tick. v1.2.1 persists a start timestamp to `localStorage`, which is how time while closed or asleep gets credited | CORE-04, CORE-05, CORE-06, CORE-07, DATA-10 | [x] | [x] | **CORE-04 to CORE-07, DATA-10.** The clock is a main-process accumulator with an absolute deadline; nothing in the renderer counts a second, and v1.2.1's `localStorage` startTime - which is how time while closed got credited - is gone (ARCH-03). Time while closed or asleep adds **zero**, proved to the second in `tests/timer-service.test.ts` and in the packaged `timer` smoke case. |

## Work History (`src/pages/work-history.html` — 36 handler sites, 13 API call sites)

| # | Screen | Element | Event | Behavior | Req | Reimplemented | Verified | Evidence, or why not |
|---|---|---|---|---|---|---|------|
| 30 | History | Session group card | click | Expand/collapse the day's detail section and rotate the chevron; clicks landing on a button are ignored | HIST-01 | [x] | [ ] | `SessionGroupCard`'s header is a real `<button>` with `aria-expanded`, so v1.2.1's `e.target.closest('button')` guard is unnecessary rather than reimplemented. **Deviation (08-B):** the chevron is on every card - v1.2.1 drew it only on multi-session cards but expanded any card that was clicked, and edit/delete live inside the fold. Not exercised. |
| 31 | History | Back button | click | Navigate to Home | SPA-01 | [x] | [ ] | `ScreenHeader` back chevron to Home. Rendered in all five `work-history` captures; the navigation is not exercised. |
| 32 | History | Companies button | click | Navigate to Companies | SPA-01 | [x] | [ ] | The violet Companies shortcut is kept and is now the full width of its row, the Day End export having gone with the export (08-B). Rendered in the captures. |
| 33 | History | Session card edit / delete buttons | click (inline `onclick`) | `event.stopPropagation()`, then open the edit or delete-confirm modal for that session. The session name is interpolated into the attribute — S2 | HIST-04, HIST-06 | [x] | [x] | **S2 / HIST-06 closed by construction.** There is no interpolated `onclick`: edit and delete are React handlers on the row. `eslint.config.js` bans `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and a JSX handler written as a string; `tests/lint-coverage.test.ts` probes all twelve spellings against five sanctioned ones, and `tests/renderer-structure.test.ts` finds none already in the tree. The packaged escaping probe is run against a **company** name (row 77); a session name takes the same path and is not separately probed. |
| 34 | History | Save-edit-session button | click | `updateSession` with the edited name, duration, company and note, honouring note-required | HIST-04 | [x] | [ ] | `sessions:update`. Note-required is honoured on the edit form and refused below IPC whatever the screen does (`tests/sessions-service.test.ts`). **Corrected 2026-09-16 (08-REVIEW-SCREENS BL-01, BL-02):** when this row was first ticked the form could not be submitted at all for any duration that was not a multiple of thirty minutes - `step="0.5"` inside a real `<form>` - and when it could, the round trip through a one-decimal hours string rewrote the duration by up to three minutes even when only the note had changed. Both are closed: the duration is whole hours and whole minutes over an integer second count, an untouched pair writes the stored seconds back byte-identical (`tests/renderer-duration.test.ts`), and `tests/form-constraints.test.ts` drives the real attributes in an offscreen Electron 44 window and asserts the submit fires for every value these screens hold. The pointer path itself is still not exercised. |
| 35 | History | Edit modal close / backdrop | click | Dismiss without saving | SPA-03 | [x] | [ ] | Shared `Modal`, with a fixed header over a body that scrolls at `max-h-[70vh]` - v1.2.1's own bound. Not exercised. |
| 36 | History | Confirm-delete-session button | click | `deleteSession`, then reload the list | HIST-04 | [x] | [ ] | `sessions:delete`, then the list reloads through a query invalidation rather than a re-render call. Not exercised. |
| 37 | History | Cancel-delete / backdrop | click | Dismiss without deleting | SPA-03 | [x] | [ ] | Not exercised. |
| 38 | History | Add-session FAB | click | Load companies and open the manual add-session modal | HIST-04 | [x] | [ ] | `FloatingAction` opens `SessionForm` with the companies loaded. Rendered in the captures; the press is not exercised. |
| 39 | History | New-session date button | click | Open the date picker for the session being added | HIST-04, TIMER-04 | [x] | [ ] | **Deviation (08-B):** the nested date-picker modal is not carried. Its three quick dates are buttons inside the session form, above the date field - a modal on top of a modal is ambiguous once both portal into one root. The capability is present. Not exercised. |
| 40 | History | New-session quick date / custom date | click / change | Set the new session's date by day offset or from the ISO value | HIST-04, TIMER-04 | [x] | [ ] | As row 39: day-offset buttons and the ISO field, both on the form. Not exercised. |
| 41 | History | Save-new-session button | click | `saveSession` for a manually entered past session | HIST-04, TIMER-04 | [x] | [ ] | `sessions:create` for a manually entered past session. Not exercised. |
| 42 | History | Add modal close / backdrop | click | Dismiss without saving | SPA-03 | [x] | [ ] | Not exercised. |
| 43 | History | Filter button | click | Load companies and open the filter modal seeded from `localStorage.sessionFilters` | HIST-03 | [x] | [ ] | **Deviation (08-B):** seeded from `features/history/state/filters.store.ts`, not from `localStorage.sessionFilters` - ARCH-03 bans web storage in this renderer, main cannot read it and a cleared profile forgets it. The filter survives every route change, which is what the persistence was doing in an app where every route change was a page load; **it is lost on quit, and that is a real behaviour change.** |
| 44 | History | Apply-filters button | click | Persist companies, date range, duration range, goal filter, sort field and sort order to `localStorage`, then reload the list | HIST-02, HIST-03 | [x] | [x] | **B7 closed:** the goal filter asks what the **day** totalled, so a day of four two-hour sessions stops disappearing from its own filter - v1.2.1 compared a single session against the whole target. The day totals are taken before any filter runs, or narrowing to one company would change whether the day met its target. `tests/history-grouping.test.ts` runs the filter and the buckets, 24 assertions. Persistence deviates as in row 43. |
| 45 | History | Clear-filters button | click | Remove the saved filters and reload | HIST-03 | [x] | [ ] | Clearing resets the store to its defaults and the list reloads. Not exercised. |
| 46 | History | Goal-filter radios | change | Restyle the selected radio label (pure presentation) | | [x] | [ ] | Pure presentation, as `peer-checked:` styling on the label rather than a change handler restyling it. Not exercised. |
| 47 | History | Filter modal close / backdrop | click | Dismiss without applying | SPA-03 | [x] | [ ] | Not exercised. |
| 48 | History | Export-Day-End button | click | `previewDayEnd` for the chosen date and render the preview modal before anything is sent | EXPORT-01, EXPORT-02 | [-] | [x] | **Owner-removed** (2026-09-11): there is no Google Sheets export, so no Day End preview. `tests/sheets-retirement.test.ts` scans for the retired surface and `tests/ipc-parity.test.ts` records `previewDayEnd` as removed with its reason. The button's own emerald shadow is one of the settled differences in `VISUAL-PARITY-DIFF.md`. |
| 49 | History | Change-export-date button | click | Open the export date modal | EXPORT-01 | [-] | [x] | Owner-removed, as row 48. |
| 50 | History | Export quick date / custom date | click / change | Reselect the export date and re-run the preview | EXPORT-03, EXPORT-05 | [-] | [x] | Owner-removed, as row 48. |
| 51 | History | Confirm-export button | click | Refuse an empty entry set with an error toast; otherwise `exportDayEnd`, disable the button with a spinner, and report the outcome | EXPORT-06, CORE-15 | [-] | [x] | Owner-removed, as row 48. `exportDayEnd` is recorded as removed in `tests/ipc-parity.test.ts`. |
| 52 | History | Export modal close / cancel / backdrop | click | Dismiss without exporting | SPA-03 | [-] | [x] | Owner-removed, as row 48. |
| 53 | History | Page-local alert close / backdrop | click | Dismiss this page's copy of the alert modal | SPA-04 | [x] | [ ] | One shared alert instead of a copy per page. Not exercised. |
| 54 | History | Session list render | (no listener) | Sessions are bucketed into This Week / Last Week / Older and the list is built by repeated `innerHTML +=` | HIST-01, HIST-05 | [x] | [x] | **B8 closed:** `buildHistory` fills three buckets from `weekBucketOf`. v1.2.1 defined `groupSessionsByWeek()` and called it from nowhere, blanked and hid the Last Week and Older sections on every render, and appended every card to This Week - three headings over one list. Run across both week boundaries, including a session dated after today, in `tests/history-grouping.test.ts`. **HIST-05:** the list is one value React commits once rather than repeated `innerHTML +=`; the single commit is what makes that true, and it is not observable from a test. |

## Settings (`src/pages/settings.html` — 24 handler sites, 25 API call sites)

| # | Screen | Element | Event | Behavior | Req | Reimplemented | Verified | Evidence, or why not |
|---|---|---|---|---|---|---|------|
| 55 | Settings | Back button | click | Navigate to Home | SPA-01 | [x] | [ ] | `ScreenHeader` back chevron to Home. Rendered in all five `settings` captures; the navigation is not exercised. |
| 56 | Settings | About button | click | `window.open` the GitHub repository — leaves the app, so the new shell must deny in-app navigation and hand it to the OS browser | IPC-09 | [x] | [ ] | **NOT FULLY MET, and deliberately.** The deny half is done and proved: the renderer refuses `window.open` and refuses a top-level navigation away from itself (WR-01; smoke *window.open from the page was refused and opened no window*, *a top-level navigation away from the renderer was refused*). The hand-off to the OS browser is **not** done - no channel opens a URL, so About shows the address as text in the shared alert and its trailing glyph is a chevron rather than `open_in_new` (08-E). Closing it means a `shell.openExternal` channel with an allowlist; that is release work, not a screens slice. |
| 57 | Settings | Daily-target button | click | Open the daily work-hour target picker | SET-01 | [x] | [ ] | `DailyTargetForm` in the shared `Modal`. Not exercised. |
| 58 | Settings | Target preset buttons | click | Select a preset daily target | SET-01 | [x] | [ ] | Six quick-hour buttons. Not exercised. |
| 59 | Settings | Apply-custom-time button | click | Apply a manually typed daily target | SET-01 | [x] | [ ] | **Deviation (08-E):** the custom field accepts 24:00 where v1.2.1's stopped at 23. The service's cap is exactly 24:00, and a picker that cannot express its own cap makes the cap unreachable. Every bound the screen shows is the one the service enforces, held to the same object in `tests/settings-service.test.ts`. Not exercised. |
| 60 | Settings | Time modal close / backdrop | click | Dismiss without changing the target | SPA-03 | [x] | [ ] | Not exercised. |
| 61 | Settings | Save-settings button | click | Write 13 settings through `setSetting`: `daily_target`, `goal_notification`, `exclude_weekends_from_streak`, the six `pomodoro_*` keys, `script_url`, `export_half_hour_precision` | SET-01, SET-02, SET-05 | [x] | [x] | **Deviation:** ten settings, not thirteen. `script_url` and `export_half_hour_precision` went with the owner-removed export (migration 0002 drops the latter); `start_reminder` and `haptic_feedback` are not carried because `database/db.js:112-113` writes them as defaults and **no v1.2.1 screen ever reads either** - a grep of `legacy/` finds no use. The write is a partial patch carrying only keys that actually changed, compared as text so a stored 90 seconds showing as `2` in a minutes box is never written back as 120; and it is refused whole if any field is out of range rather than half-applied. `tests/settings-screen.test.ts` runs the real validator at min, min-1, max and max+1 for every field and over thirteen typed strings per field - 41 tests. **Corrected 2026-09-16 (08-REVIEW-SCREENS WR-01):** the Verified tick rested on that module-level suite, and the refusal path it exercises was unreachable through this control - Chromium's own constraint validation blocked the submit before `reviewDraft` ran, for both classes the slice is built around. The form defers to its own review with `noValidate` now, and `tests/form-constraints.test.ts` asserts in the shipped runtime that a value Chromium calls invalid still reaches the screen. |
| 62 | Settings | Delete-all-data button | click | Open the destructive confirmation. **Bound through `document.querySelector('.mt-8.mb-8 button')`** — a Tailwind spacing tweak silently detaches the delete-all-data handler | SET-04, SPA-13 | [x] | [x] | **SPA-13 / SET-04 closed.** The button carries `data-testid="reset-all-data"`, pinned screen to `src/main/config.ts` to harness (D-24). The packaged smoke asserts two things, because they are two claims: the identifier resolves to **exactly one** element, and v1.2.1's `document.querySelector('.mt-8.mb-8 button')` resolves to **none**. It failed on its first run - the markup had been ported verbatim, `mt-8 mb-8` and all - and `654c485` rewrote the same 2rem as `my-8`. |
| 63 | Settings | Confirm-delete-all button | click | `deleteAllSessions`, then show a result modal | SET-04 | [x] | [ ] | `sessions:deleteAll` behind the confirm, and the toast names what actually went - *Deleted 3 work sessions.* - with zero reported neutrally rather than as a success. The channel is exercised in `tests/sessions-service.test.ts`; the dialog is not. |
| 64 | Settings | Delete-all result close / backdrop | click | Dismiss the result modal | SPA-03 | [x] | [ ] | Not exercised. |
| 65 | Settings | Cancel-delete-all / backdrop | click | Dismiss without deleting | SET-04 | [x] | [ ] | Only `confirmed === true` reaches the channel. Not exercised. |
| 66 | Settings | Setup-instructions button | click | Open the Google Sheets setup instructions modal | EXPORT-02 | [-] | [x] | **Owner-removed** with the Google Sheets export: there is no Timesheet Integration section at all. Its emerald icon tile, its violet `code` glyph and the Setup Instructions button's blue border are four of the settled differences in `VISUAL-PARITY-DIFF.md`. |
| 67 | Settings | Instructions modal close / backdrop | click | Dismiss | SPA-03 | [-] | [x] | Owner-removed, as row 66. |
| 68 | Settings | Pomodoro-enabled toggle | change | Show or hide the duration block and call `saveSettings()` — this is the source of the spurious "settings saved" dialog | SET-03 | [x] | [x] | **SET-03 closed.** The toggle writes immediately - it is a mode change as well as a preference, so Home must not disagree with it - and raises nothing: the switch moving is the feedback. This is a claim about something **not** happening, so `tests/settings-screen.test.ts` pins the source: the screen opens exactly two named dialogs and builds none inline, the toggle's handler contains `setMode.mutate` and none of `openDialog`, `pushToast` or `update.mutate`, the form raises nothing of its own, and `'Settings saved'` is attached to the mutation's `onSuccess` - the one place a save has actually happened. |
| 69 | Settings | Pomodoro duration inputs (work, short break, long break, sessions-until-long-break) | input | Live-update the `N min` display label beside each control | SET-02 | [x] | [ ] | Each `NumberSettingCard` live-updates its own label. **Deviation (08-E):** the bound each field states is the one the service enforces (1-240 minutes, 1-12 pomodoros), not v1.2.1's `min="1" max="60"` attributes, which nothing ever enforced. **Carried over as-is:** the four fields render only when Pomodoro is enabled, exactly as v1.2.1 did. Not exercised. |
| 70 | Settings | Page-local alert close / backdrop | click | Dismiss this page's copy of the alert modal | SPA-04 | [x] | [ ] | One shared alert instead of a copy per page. Not exercised. |
| 71 | Settings | Settings load | (no listener) | On init, read all 13 settings through `getSetting` and populate every control | SET-01, SET-02, SET-05 | [x] | [x] | The ten settings are read once when the form opens, and a field nobody typed into is never written back. The packaged smoke writes 27000 seconds to the fixture **before** the window loads and reads `07:30` off the screen, reads the computed `justify-content` of a checked switch, and finds all four duration fields with pomodoro enabled on disk. **Corrected 2026-09-16 (08-REVIEW-SCREENS NT-05):** the probe counted `input[type="number"]` under `#root`, which would keep answering 4 for four unrelated number inputs; it counts `[data-field="pomodoro-duration"]`, so the figure means what this row says it means. |

## Companies (`src/pages/companies.html` — 15 handler sites, 6 API call sites)

| # | Screen | Element | Event | Behavior | Req | Reimplemented | Verified | Evidence, or why not |
|---|---|---|---|---|---|---|------|
| 72 | Companies | Back button | click | Navigate to Home | SPA-01 | [x] | [ ] | `ScreenHeader` back chevron. **Deviation (08-A):** it goes to Work History, which is where `companies.html`'s went. Rendered in all five `companies` captures; the navigation is not exercised. |
| 73 | Companies | Add-company FAB | click | Open the create-company modal | COMP-01 | [x] | [ ] | `FloatingAction` opens `CompanyForm`. Rendered in the captures; the press is not exercised. |
| 74 | Companies | Save-company button | click | `createCompany` with the name and the note-required flag, then reload the list | COMP-01, COMP-02 | [x] | [x] | `companies:create` with the note-required flag. **Exercised in the packaged app:** the smoke creates a company, routes to `#/companies` and reads the row back, then removes it again - it did not at first, and the legacy-migration case counted four companies where three survived. |
| 75 | Companies | Create name input | keypress `Enter` | Forward Enter to the save-company button | COMP-01 | [x] | [ ] | Native form semantics: `CompanyForm` is a `<form onSubmit>` with a `type="submit"` button. Not exercised. |
| 76 | Companies | Create modal close / backdrop | click | Dismiss without creating | SPA-03 | [x] | [ ] | Shared `Modal`. **Deviation (08-A):** the panel is `w-80 rounded-2xl` where v1.2.1's was `max-w-sm rounded-3xl` - 64px narrower, corners 8px tighter - because criterion 5 allows one modal. The form's contents are ported field for field. |
| 77 | Companies | Company card edit / delete buttons | click (inline `onclick`) | Open the edit or delete-confirm modal. The company name is interpolated into the attribute with only `'` escaped — S2 injection hole | COMP-03 | [x] | [x] | **S2 / COMP-03 closed by construction** - React escapes a JSX child, and the lint bans in row 33 close the doors around it. **Exercised in the packaged app:** a company named `<img src=x onerror=alert(1)>` - the brief's own payload, pinned to the harness by `tests/main-config.test.ts` - is rendered, and three answers read back: the name is in `#root`'s text, `#root` contains **zero** elements carrying `src="x"` or an `onerror`, and the markup carries `&lt;img src=x onerror=alert(1)&gt;`. The third is what stops the first two passing because the row is missing. |
| 78 | Companies | Update-company button | click | `updateCompany` with the edited name and note-required flag | COMP-01, COMP-02 | [x] | [ ] | `companies:update` with the edited name and flag. Not exercised. |
| 79 | Companies | Edit name input | keypress `Enter` | Forward Enter to the update-company button | COMP-01 | [x] | [ ] | Native form semantics, as row 75. Not exercised. |
| 80 | Companies | Edit modal close / backdrop | click | Dismiss without saving | SPA-03 | [x] | [ ] | Not exercised. |
| 81 | Companies | Confirm-delete-company button | click | `deleteCompany`, then reload the list | COMP-04 | [x] | [ ] | `companies:delete`, then the list reloads through a query invalidation. Exercised below IPC in `tests/companies-service.test.ts`; the dialog is not. |
| 82 | Companies | Cancel-delete / backdrop | click | Dismiss without deleting | COMP-04, SPA-03 | [x] | [ ] | Not exercised. |
| 83 | Companies | Delete confirmation copy | (no listener) | The warning states the session count for the company, passed in from the list render rather than from the delete query | COMP-04, COMP-05 | [x] | [x] | **COMP-04 / COMP-05.** The count comes from the session list the screen already holds, so the warning is true **before** the user answers it - `companies:delete` reports its count after the rows are gone. The two are then compared, and a mismatch is reported as a warning naming the real figure rather than as a success, because that case means the user answered a question about something else. `tests/companies-screen.test.ts` runs the count and the wording. **Deviation (08-A):** the confirm is the shared `AlertDialog`, so the count sits in the dialog body rather than in a red inset box. **Corrected 2026-09-16 (08-REVIEW-SCREENS BL-03, WR-03):** the Verified tick rested on the pure module, which is correct in isolation and was undone by the screen. Two `?? 0`s collapsed "not known yet" into "0 sessions", so the destructive confirmation for a company holding twelve could read exactly like one for a company holding none - while the session read was in flight, after it failed, or when `list()` dropped rows the cascade deletes anyway. And the mismatch toast was worded on `removed === 0` while coloured on `removed === expected`, so a cascade that took none over a warning that named three read "Company deleted successfully" in orange. Unknown is a value now, no confirmation opens over a count the screen does not have, and one condition decides both the colour and the words. |
| 84 | Companies | Page-local alert close / backdrop | click | Dismiss this page's copy of the alert modal | SPA-04 | [x] | [ ] | One shared alert instead of a copy per page. Not exercised. |

## Preload surface — the IPC contract Phase 6 must reproduce

All 25 names, from `preload-surface.txt`. IPC-01 requires every capability except navigation to have
a counterpart in the new typed bridge.

| # | Preload API | Channel | Called from `src/` | Behavior | Req | Reimplemented | Verified | Evidence, or why not |
|---|---|---|---|---|---|---|------|
| 85 | `saveSession` | `save-session` | yes (2) | Persist a completed session | TIMER-02, IPC-01 | [x] | [x] | `sessions:create`. Mapped and asserted in `tests/ipc-parity.test.ts`; contract shape in `tests/ipc-contract.test.ts`; answered from the real database in the packaged smoke. |
| 86 | `getSessions` | `get-sessions` | yes (3) | Read all sessions | HIST-01, IPC-01 | [x] | [x] | `sessions:list`. As row 85. |
| 87 | `getSessionsByDate` | `get-sessions-by-date` | yes (1) | Read one day's sessions | HIST-01, IPC-01 | [x] | [x] | `sessions:listByDateRange`. As row 85. |
| 88 | `updateSession` | `update-session` | yes (1) | Edit a past session | HIST-04, IPC-01 | [x] | [x] | `sessions:update`. As row 85. |
| 89 | `deleteSession` | `delete-session` | yes (1) | Delete one session | HIST-04, IPC-01 | [x] | [x] | `sessions:delete`. As row 85. |
| 90 | `deleteAllSessions` | `delete-all-sessions` | yes (1) | Destructive wipe from Settings | SET-04, IPC-01 | [x] | [x] | `sessions:deleteAll`. As row 85. |
| 91 | `createCompany` | `create-company` | yes (1) | Create a company | COMP-01, IPC-01 | [x] | [x] | `companies:create`. As row 85, and exercised end to end by the packaged escaping probe. |
| 92 | `getCompanies` | `get-companies` | yes (6) | List companies | COMP-01, IPC-01 | [x] | [x] | `companies:list`. As row 91. |
| 93 | `getCompany` | `get-company` | yes (1) | Read one company, including the note-required flag | COMP-02, IPC-01 | [x] | [x] | `companies:get`. As row 85. |
| 94 | `updateCompany` | `update-company` | yes (1) | Rename a company or retoggle note-required | COMP-01, COMP-02, IPC-01 | [x] | [x] | `companies:update`. As row 85. |
| 95 | `updateCompanyExcelConfig` | `update-company-excel-config` | **no** | Dead — remove, do not port | SPA-15 | [-] | [x] | Confirmed **absent**. `tests/ipc-parity.test.ts` records it removed, reason *the per-company sheet columns; migration 0002 took `excel_column` and `note_column` off the table*. One of the five v1.2.1 names with no counterpart. |
| 96 | `deleteCompany` | `delete-company` | yes (1) | Delete a company | COMP-04, IPC-01 | [x] | [x] | `companies:delete`. As row 85. |
| 97 | `getSessionsGrouped` | `get-sessions-grouped` | **no** | Dead — remove, do not port | SPA-15 | [-] | [x] | Confirmed **absent** (SPA-15). `tests/ipc-parity.test.ts` records it removed: Work History groups the sessions a date range returns, in the renderer, rather than asking the database for a grouping it then flattens. |
| 98 | `getSessionsByDateCompany` | `get-sessions-by-date-company` | **no** | Dead — remove, do not port | SPA-15 | [x] | [x] | **The Phase 1 disposition was revised.** This row said *remove, do not port*; `sessions:listByDateAndCompany` exists and `tests/ipc-parity.test.ts` maps it. The capability was cheap to keep once the date-range channel existed, and the five names actually dropped are #95, #97, #107 and the two export APIs the owner removed after this checklist was written. Recorded rather than quietly re-scoped. |
| 99 | `getSetting` | `get-setting` | yes (27) | Read one setting by key | SET-01, IPC-01 | [x] | [x] | `settings:get`. As row 85. |
| 100 | `setSetting` | `set-setting` | yes (12) | Write one setting by key | SET-01, IPC-01 | [x] | [x] | `settings:update`. As row 85. |
| 101 | `getWeekTotal` | `get-week-total` | yes (1) | Weekly total for the home card | CORE-08, IPC-01 | [x] | [x] | `stats:weekTotals`. As row 85. |
| 102 | `getCurrentStreak` | `get-current-streak` | yes (1) | Current streak for the home card | CORE-08, TIMER-09, IPC-01 | [x] | [x] | `stats:streak`. As row 85; the streak itself is run over fixtures in `tests/stats.test.ts`. |
| 103 | `getTodaySessions` | `get-today-sessions` | **no** | Dead — remove, do not port | SPA-15 | [x] | [x] | **Phase 1 disposition revised**, as row 98: mapped to `sessions:listByDateRange` in `tests/ipc-parity.test.ts`. |
| 104 | `getTodaysSessionsSummary` | `get-todays-sessions-summary` | **no** | Dead — remove, do not port | SPA-15 | [x] | [x] | **Phase 1 disposition revised**, as row 98: mapped to `stats:dayProgress` in `tests/ipc-parity.test.ts`. |
| 105 | `previewDayEnd` | `preview-day-end` | yes (1) | Build the export preview | EXPORT-02, IPC-01 | [-] | [x] | Confirmed **absent** - the Google Sheets export the owner removed on 2026-09-11. Recorded with that reason in `tests/ipc-parity.test.ts`. |
| 106 | `exportDayEnd` | `export-day-end` | yes (1) | Perform the export | EXPORT-01, EXPORT-06, IPC-01 | [-] | [x] | Confirmed **absent**, as row 105. |
| 107 | `navigateTo` | `navigate` | yes (1) | `mainWindow.loadFile(userSuppliedPath)`. **Deliberately not ported** — the channel is deleted together with its path-traversal hole | IPC-02 | [-] | [x] | Confirmed **absent**, deliberately. `tests/ipc-parity.test.ts` finds no channel, event or string literal naming it outside the `will-navigate` guard: an unvalidated page argument reached `loadFile`, and `HashRouter` needs no server to rewrite a path under `file://`, so the channel is deleted rather than validated. |
| 108 | `minimizeWindow` | `minimize-window` | yes (1) | Minimize the window | IPC-01 | [x] | [x] | `window:hide`. Mapped in `tests/ipc-parity.test.ts`; exercised by the packaged tray and close cases. |
| 109 | `closeWindow` | `close-window` | yes (1) | Close the window — in v1.2.1 this re-hides to the tray rather than quitting | IPC-08 | [x] | [x] | `window:hide` plus `app:quit`. **IPC-08 closed:** v1.2.1's close re-hid to the tray with no way to quit from the window. The smoke proves both directions, including that with no tray to hide to the window really closes (WR-03). |
| 110 | `saveSetting` | — | yes (2) | **Called but never exposed (B4).** `index.html:1434` and `:1459` write `pomodoro_enabled` through a name the bridge does not have, so the write silently never happens. Parity means fixing it, not reproducing it | SET-03, POMO-06 | [x] | [x] | **B4 closed.** v1.2.1 called `window.api.saveSetting` at `index.html:1434` and `:1459` - a name `preload.js` never exposed - so both `pomodoro_enabled` writes raised a `TypeError` and never landed. `tests/ipc-parity.test.ts` carries it as the one demand-side name with no supply side and holds it mapped to `settings:update`; `tests/renderer-structure.test.ts` holds exactly one file writing the key. |

The 25 exposed APIs (#85–#109) map one-to-one onto the 25 `ipcMain` channels in `ipc-channels.txt`.
Row #110 is a demand-side name with no supply side; it is not part of the 25.

## Exit gate

REL-06 is satisfied when every `Reimplemented` and every `Verified` box above is ticked, except the
rows ticked by confirming the capability is **absent**. Only then does SPA-14 delete the legacy
renderer in its own commit.

### Status at the end of Phase 8, stated plainly

**`Reimplemented` is complete: 110 of 110.** 96 behaviours exist in the SPA and 14 are confirmed
absent - and the absences are the intended ones, each with a test that would fail if the capability
came back.

**`Verified` is 52 of 110, and that is the honest number.** It is not a sampling decision: the 58
unticked rows are pointer interactions, and a repository that renders no component in any test
cannot exercise one. Phase 8's own scope note said so before the first screen was written - *"that
makes the owner's eyes part of the gate for anything about how a screen looks, and it is why
criterion 2 exists as a human checkpoint rather than as an assertion"*. Calling those rows verified
because the code that implements them was read would make this document say something untrue about
itself, which is worse than the gap it would paper over.

**What was done instead of pretending.** Criterion 2's other half - the visual gate - was moved from
an eyeball comparison to a computation: `tools/baseline/capture-v2.mjs` photographs the packaged SPA
through the same reader, property set, sizes, timezone, locale and scale factor that photographed
v1.2.1, and `tools/baseline/diff-computed.mjs` diffs the two and exits non-zero on any difference
that is not in its register with a reason. **Corrected 2026-09-16 (08-REVIEW-TIMER WR-07,
08-REVIEW-SCREENS WR-05):** when that sentence was written, nothing invoked either script - no
package.json script, no test, no workflow - so a gate documented as exiting non-zero exited non-zero
at nobody, and the 29-difference register could not go stale in a way any check would notice.
`npm run parity:check` is the invocation, it also fails on a `VISUAL-PARITY-DIFF.md` that is not
what the run produces, and package.yml runs it on the Windows smoke leg. That found three defects nothing else had - every icon in
the app rendering at 24px, every dialog rendering in the OS default font, and Tailwind v4's
respecified palette shifting the accent colours by up to 69 points on a channel - and all three are
fixed. `baselines/v1.2.1/VISUAL-PARITY-DIFF.md` is the result: 29 differences, 0 unexplained.

**So SPA-14 proceeds on this reading:** the behaviour inventory is fully accounted for, the visual
gate is green and reproducible, and the 58 unexercised rows are recorded here as the UAT list rather
than closed. The deletion is its own commit, so it reverts as a unit if the owner reads the gate
differently.

---

# Closing handoff — written at the end of Phase 1

Everything below is a fact a later phase needs and would otherwise have to re-derive, recorded
here rather than only in a plan summary because this file is what those phases open. Each note
states the **consequence**, not just the fact: a fact without its consequence gets read, agreed
with, and then not acted on.

## Phase 1's five roadmap criteria, checked against the artifacts rather than against memory

| # | Criterion | Evidence on disk |
|---|---|---|
| 1 | A push to `main` produces no release; releases come from a `v*` tag or manual dispatch and are drafts | `.github/workflows/build-release.yml` is absent; `release.yml` triggers on `push: tags: ['v*']` and `workflow_dispatch` only, with no `branches:` key, and carries `draft: true`. Empirically confirmed in 01-01: three pushes produced only `Verify` runs and the published release count stayed at 14. |
| 2 | The build fails if `package.json`'s `name` changes or a top-level `productName` appears | `tests/app-identity.test.ts`, 7 assertions, run by `verify.yml` via `npm test`. Five dangerous mutations were injected into a scratch copy of `package.json` in 01-02 and all five were caught. |
| 3 | The backup captures uncheckpointed `-wal` content that a file copy demonstrably loses | `tests/backup.test.ts` → *CUSTODY-03: the online backup captures uncheckpointed WAL content*. Source 45 sessions / 22,000 s; naive copy 5 / 18,000 with `integrity_check` reporting **ok**; online backup 45 / 22,000. |
| 4 | The restore path returns a damaged database to service, proven by a test | `tests/backup.test.ts` → *CUSTODY-05: restore returns a damaged database to service*. The database is overwritten with non-database bytes, observed to be unopenable, restored, and found to hold its exact pre-damage row count and summed duration. |
| 5 | A parity evidence bundle is committed and contains no real user data | This file (110 behaviour rows), `handlers.tsv`, `api-calls.tsv`, `preload-surface.txt`, `ipc-channels.txt`, 20 PNGs in `pixels/`, 20 JSON records in `computed/`, `MANIFEST.md`. `git ls-files -- '*.db' '*.db-wal' '*.db-shm' '*.exe' '*.dmg'` matches nothing. |

## For Phase 2 — toolchain, scaffold and build pipeline

- **The identity guard's file list is hard-coded and will silently stop covering anything.**
  `tests/app-identity.test.ts:96` scans exactly `['main.js', 'preload.js', 'database/db.js']` for
  `app.setName` / `app.setPath`. The moment the tree becomes `src/main/**` those three paths no
  longer exist, and a test that finds no files to scan **passes**. It must become a glob over the
  whole source tree in the same commit that moves the layout — not afterwards, because between
  the two commits the guard protects nothing while still reporting green.
- **A build step that generates a `package.json` is a `userData` vector this test cannot see.**
  The guard reads the repository's `package.json`. `userData` is resolved by Electron from the
  `name` in the manifest **inside the packaged application**, which electron-builder can rewrite
  via `build.extraMetadata`. A scaffold that emits its own manifest, or a builder config that
  injects a different `name` or `productName`, orphans every existing `krono.db` without
  tripping a single assertion. This is precisely what BUILD-01's port-in-place rule mitigates:
  keep one manifest, keep it the one under test.
- **`eslint@9.39.2` is npm-deprecated and the pin is deliberate.** `9` is the `maintenance`
  dist-tag; `latest` is `10.x`. It was pinned because Phase 1's job was data custody, not lint
  modernisation. `typescript-eslint@8.69.0` peers `^8 || ^9 || ^10`, so the upgrade path is open.
  **BUILD-13 decides**; leaving it un-decided means shipping a deprecation warning on every
  `npm ci` for the rest of the milestone.
- **`npm start` is expected to FAIL until the runtime moves to Electron 44, and the reason is the
  N-API level, not a broken script.** `better-sqlite3@13.0.3` is compiled at N-API 10, which needs
  Node ≥ 22.14. Electron 28.3.3 — what this application ships — bundles Node 18.18.2 and caps at
  N-API 9. Loading the prebuild under Electron 28 **segfaults**: exit 139, no diagnostic, not a
  catchable error. A future reader who finds a broken start script and no explanation will "fix"
  it by downgrading the driver, which would undo D-09 and make the backup module untestable in
  plain Node again. Anything that needs a running v1.2.1 uses the pinned installer archived per
  CUSTODY-08.
- **D-08's substantive claim holds; its broader reading does not.** A shipped prebuild loads on
  both verified platforms and nothing is compiled — that part is solid, and `npmRebuild: false`
  is correct. But npm's implicit `node-gyp rebuild` fires for any package carrying a
  `binding.gyp`, and it **is** invoked on the Ubuntu runner: it configures (hence `config.gypi`),
  and node-gyp configure needs Python on `PATH` even though it compiles nothing. Hosted runners
  have Python, so this is free in CI; it is not necessarily free on a contributor's machine.
  BUILD-05 / BUILD-06 must not lean on the stronger form of the claim.

## For Phase 4 — database engine and migrations

- **`src/lib/db/backup.ts` is the module DATA-03 calls.** It is already in the target structure
  with an injected path and no Electron import, which is the whole reason D-08 required it be
  written once here rather than twice. `backupDatabase(sourcePath, backupDir, { now, deadlineMs })`
  returns the destination path, the page count and the verification; it refuses a destination that
  already exists, so a second migration attempt cannot clobber the good copy the first one made.
  `pruneBackups(backupDir, keep)` takes the retention count as a **parameter defaulting to 3**, so
  DATA-03 sets its own policy without editing the module — and it can never delete the newest
  backup, whatever count it is passed.
- **`makeOrphanFixture()` exists for DATA-12, but the premise DATA-12 was sized on is wrong.**
  CB-4 reasons that `database/db.js` issues no `PRAGMA foreign_keys`, therefore the declared
  `ON DELETE CASCADE` is inert for every user. The premise is true; the conclusion is false.
  `better-sqlite3` compiles SQLite with `SQLITE_DEFAULT_FOREIGN_KEYS`, so enforcement is ON from
  the moment the driver opens a connection — verified in the driver this repo now uses *and* in
  the 9.x build bundled inside the shipped v1.2.1 asar. The cascade is **live for every user**.
  Consequence: the app's own delete path cannot produce an orphan, so **DATA-12 is defensive
  cleanup after third-party tools** (the `sqlite3` CLI, DB Browser for SQLite, a hand-rolled
  repair script, a partial restore), not cleanup of a population the application creates. Size
  and message it accordingly, and note that the fixture has to *manufacture* the state with an
  explicit pragma.
- **D-05 resolved in the negative: there is no second legacy schema variant.** The generated
  fixture's `sqlite_master` matches the owner's real database **byte for byte**, all five objects
  including the implicit `sqlite_sequence`. Consequence: **DATA-04's adoption logic has exactly
  one shape to handle**, and `tests/fixtures/v121.sql` is that shape. It runs the `ALTER TABLE`
  migration path rather than flat `CREATE TABLE`s on purpose — `sqlite_master` stores each
  statement as typed, so a tidier fixture would be semantically identical, textually different,
  and would read as a legacy variant that does not exist in the wild.
- **A restore must remove the target's stale sidecars before copying.** A `-wal` describing a
  database that no longer exists is the separated-WAL hazard SQLite warns about.
  `restoreDatabase` does this; anything else that replaces a database file must too.

## For Phase 5 — repositories, services, ports and adapters

Neither D-01 nor D-02 produces an artifact in Phase 1. Both are recorded here so the phase that
owns them (CORE-09, CORE-10) inherits the reasoning instead of re-deriving it.

- **D-02: the `ExportTarget` seam is designed with the company fork as its primary intended
  consumer, not as speculative future-proofing.** That fork replaces the Google Sheets target with
  its own API target. Treat the seam as a real integration contract: a target-neutral payload,
  registry-based target selection, and **no Sheets-specific concept — column letters, row numbers
  — leaking above the target implementation**. Widening it later means touching every export call
  site and the payload shape the fork depends on.
- **D-01 is both why that matters and why it is bounded.** This repository stays the general
  product; the company-specific work happens in a **separate fork**, not by consuming this repo as
  a dependency. So architectural debt transfers directly into that fork, which raises the value of
  clean layering — but `shared/` needs no published-API polish, because there is no package
  boundary to honour.

## For Phase 8 — feature screens

- **This checklist is ticked here.** REL-06 is satisfied when every `Reimplemented` and every
  `Verified` box above is ticked, except the *do not port* rows (#95, #97, #98, #103, #104) and
  the *deliberately not ported* rows (#7, #107), which are ticked by confirming the capability is
  **absent**. Only then does SPA-14 delete `src/pages/*.html`, in its own commit.
- **Diff the baselines against `MANIFEST.md`'s recorded provenance, not against a memory of how
  they were made.** The manifest records the launch path (`installed` — the extracted, never
  executed, `Workflow.exe`), the binary and asar digests, the Electron/Chromium versions read out
  of the binary (28.3.3 / 120.0.6099.291) and the Tailwind build actually served (3.4.17 with
  `forms@0.5.10`, `container-queries@0.1.1`). A visual diff taken under a different Chromium or a
  different Tailwind is not a parity result, it is a different measurement.
- **Re-run the inventory generator and diff it; never re-read the artifacts.**
  `tools/baseline/inventory.sh` is the only thing that writes `handlers.tsv`, `api-calls.tsv`,
  `preload-surface.txt` and `ipc-channels.txt`, and `tests/inventory.test.ts` asserts the live
  tree and the committed files agree. Regenerating and diffing is what makes a stale inventory
  impossible to mistake for an authoritative one — which matters because the inventory is what
  authorises an irreversible deletion.
- **The `-wal` sidecar is not decoration in the fixtures.** Anything in Phase 8 that copies or
  seeds a database must copy the whole triple (`.db`, `-wal`, `-shm`) or use the online backup
  API. `tests/fixtures/seed.ts` `copyFixture()` is the sanctioned helper.

## Outstanding manual verifications, for the end-of-phase review

Everything Phase 1 can prove mechanically is proven mechanically. These are the ones that are
not, listed so the review has a complete set rather than an implied one.

| # | Item | Requirement | Why it is still manual | When it can close |
|---|---|---|---|---|
| 1 | A `v*` tag produces a release with `isDraft: true`, and `release.yml`'s `uses: ./.github/workflows/verify.yml` call actually resolves | CUSTODY-01 | No `v*` tag has ever been pushed, so the draft path and the reusable-workflow call have never executed. The trigger block and inputs are proven statically; the produced artifact is not. Proving it requires creating a real release. | **Phase 10**, at the first real tag: `gh release view <tag> --json isDraft` must return `true`. If the `uses:` call misbehaves, inline the steps — CUSTODY-01 is unaffected either way, because the *trigger* is the control surface. |
| 2 | The handoff notes above read as usable instructions to someone arriving three phases later | — | Whether a note will actually be understood by its future reader is a judgement about writing, not a property a test can assert. | End-of-phase UAT. |
| 3 | The archived real `krono.db` and the archived v1.2.1 installer are still present outside the repository | CUSTODY-07, CUSTODY-08 | They live on the owner's machine by design (D-03) and are pinned here only by SHA-256. Nothing in CI can see them, and nothing should. | Before Phase 4 runs a migration against real data; re-check the digests recorded in `MANIFEST.md`. |
| 4 | The real `%APPDATA%\workflow-timer\krono.db` mtime is unchanged by any future baseline re-capture | CUSTODY-10 | It proves the fixture-DB redirection worked on the owner's machine, which no runner can observe. | Any time `npm run baseline:capture` is re-run. The capture driver's redirection probe is a hard gate, but the mtime check is the independent confirmation. |

Informational, carried from `deferred-items.md` and owned elsewhere: `actions/checkout@v4` and
`actions/setup-node@v4` are annotated as Node-20-targeting and should move to `@v5` (Phase 2,
BUILD-09); the local `git remote origin` still points at the pre-rename URL and is redirected by
GitHub on every push (owner, one-off, invisible to any commit).

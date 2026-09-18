# Contributing to Workflow

Thanks for wanting to help. This is a small, opinionated codebase, and most of what follows is about
the two rules that everything else hangs off.

## The two rules

**1. No user ever loses tracked time.** Every other consideration is subordinate to this. A change
that makes a screen nicer and a session recoverable-only-from-a-backup is not an improvement. If you
touch the database layer, migrations, the timer, or anything on the quit path, say in your pull
request what you did to convince yourself no recorded time can be lost — and what you would have
seen if you were wrong.

**2. Time the user did not work is never invented.** Time elapsed while the app was closed or the
machine was asleep does not count. This is why the timer lives in the main process behind a clock
port, and why it is clamped and unit-tested rather than trusted.

## The stack

electron-vite + React 18 + TypeScript (strict) + Tailwind v4, on Electron 44 with `better-sqlite3`
and Drizzle. Node 24 — see `.nvmrc`. `npm ci`, then `npm run dev`.

Versions are pinned for reasons, not by accident. `typescript` is exactly `5.9.3` because
`typescript-eslint` refuses TypeScript 7; `vite` is 7 because `electron-vite@5` excludes 8;
`@vitejs/plugin-react` is 5 because 6 requires vite 8. "Upgrade everything to latest" will produce a
tree that does not install.

## Where code goes

The layering is enforced by ESLint (`no-restricted-imports`), not by convention, so a misplaced
import fails `npm run lint` rather than being noticed in review.

**Main process** — `ipc/` → `services/` → `src/lib/db` repositories.

- `src/main/ipc/` validates a payload with a zod schema, calls **one** service, and shapes the
  answer. It may name Electron; it may not reach a repository or an adapter.
- `src/main/services/` holds the logic and **must load with Electron stubbed to throw**. No
  `electron`, no `better-sqlite3`, no `@lib/db`, no adapter, no container, no `config`. Take a port
  from `src/main/ports/` and state structurally what you need; the container hands it to you.
- `src/main/ports/` + `src/main/adapters/` are how a service reaches the outside world. Only the
  bootstrap, `window.ts`, `lifecycle.ts`, `tray.ts`, `ipc/` and the adapters may import Electron
  directly.
- **SQL lives only under `src/lib/db`.** Everywhere else, call a repository. `sql\`\``, `.prepare()`
  and `.pragma()` outside that directory are lint errors.

**Renderer** — feature-based.

- `app/` is bootstrap, providers and `router.tsx`, which is the only route table.
- `features/<domain>/` holds `<Domain>Page.tsx`, `components/`, `hooks/`, `api/` (TanStack Query),
  `state/` (Zustand) and an `index.ts` that is the feature's whole public surface. Features import
  each other only through that `index.ts`.
- Only `features/*/api/` and `app/providers/` touch the IPC bridge. **Components never call
  `window.api`** and never touch `localStorage` or `sessionStorage` — anything durable is a row in
  the database.
- Four kinds of state stay apart: global UI store, feature store, server state (Query), local state.

**Styling is Tailwind utilities.** `src/renderer/src/styles/globals.css` is the only stylesheet: the
Tailwind import, the font imports, the `@theme` tokens, the plugin and source lines, and the v3
compatibility layer. No second CSS file, no CSS modules, no inline `style` for anything a utility
expresses. Values Tailwind cannot express go in `@theme` as tokens.

**Never use a Tailwind class as a DOM selector.** v1.2.1 reached its *delete all data* button with
`document.querySelector('.mt-8.mb-8 button')`, so a spacing tweak detached it. Use a ref, a handler,
or `data-testid`.

## Comments

Short and sparse. Comment where the intent is not obvious from the code; never restate what the code
does. A comment that records a **decision**, a **measurement**, or the **shipped defect a line
closes** is worth keeping — those are the ones that stop the next person re-introducing a bug. File
headers are one or two lines.

## The gates

A change has to pass all of these. They are what CI runs, and you can run every one locally.

| Gate | Command | What it is |
| --- | --- | --- |
| Lint | `npm run lint` | Style, plus the layering rules above. Zero errors. |
| Types | `npm run typecheck` | `tsc --noEmit` over the Node and web projects, strict. |
| Tests | `npm test` | The vitest suite. Zero failures; the handful of skips are environment-gated. |
| Build | `npm run build` | Typecheck, then main, preload and renderer. |
| Package | `npm run build:unpack` | Produces a real application directory in `dist/`. |
| Packaged smoke | `npm run smoke:packaged` | Launches the packaged binary and checks what it actually does. |
| Audit | `npm audit` | Zero vulnerabilities. |

CI additionally runs `npm test` in three timezones (UTC, America/New_York, Europe/Istanbul), builds
all four installers, and on the Windows leg runs `parity:check`, `matrix:check`, `offline:check`,
`upgrade:check` and `instance:check`.

Some of the suite is *structural* — tests that read the source and fail on a misplaced import, an
unlinted file, a stale guard or a duplicated asset. If one of those fails, it is telling you about a
rule, not about a bug. Read its message: they are written to explain themselves.

## Tests

- Anything in `src/main/services/` is unit-testable by construction. If your change is hard to test,
  the dependency probably wants to be a port.
- **Make a new test fail before you make it pass.** A guard that has never been red is decoration;
  several tests in this repository say so in their own comments.
- Do not delete a guard to make a change land. If a guard is genuinely obsolete, retire it in the
  same commit that obsoletes it, and say in the message what replaces it.

## Pull requests

1. Fork, branch from `main`.
2. Make the change. Keep commits atomic and write messages that say *why*.
3. Run the gates above.
4. Open the pull request, describing what you changed, what you verified by hand, and what you did
   not.

```markdown
## Checklist
- [ ] `npm run lint`, `npm run typecheck` and `npm test` all pass
- [ ] I ran the app and used the screen I changed
- [ ] If I touched the database, timer or quit path, I have said why no tracked time can be lost
- [ ] I added or updated tests, and watched the new ones fail first
- [ ] I did not delete or weaken a guard to make this pass
```

## Reporting a bug

Include your OS and version, the Workflow version (the tray menu's first line), what you did, what
happened, and what you expected. If it involves your data, **do not attach your database** — it is
your tracked time and your clients' names. Describe the shape of the problem instead.

## Questions

Open an issue. Thanks for reading this far.

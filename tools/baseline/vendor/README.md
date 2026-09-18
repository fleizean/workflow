# Vendored capture assets

**Generated, not authored. Do not hand-edit anything in this directory.**

These are byte-exact copies of the three third-party hosts a running v1.2.1 loads:

| Host | Loaded by | Vendored as |
|---|---|---|
| `cdn.tailwindcss.com` | `src/pages/*.html:17` | `tailwind.js` |
| `fonts.googleapis.com` | `src/styles/common.css:4-5` | `fonts-css/inter.css`, `fonts-css/material-symbols.css` |
| `fonts.gstatic.com` | the two stylesheets above | `fonts/*.woff2` |

## Why they are here

All three are live URLs, and the Tailwind Play CDN does not even ship a stylesheet — it ships the
JIT engine, which generates CSS from the live DOM at runtime. The baseline this repository captures
in Phase 1 is diffed against a re-capture in Phase 8, months later. Without a pinned copy, a change
at any of those three hosts in the intervening months would show up as a visual diff and be
attributed to the rewrite.

`tools/baseline/capture.mjs` intercepts all three hosts and fulfils every request from this
directory, verifying each file's SHA-256 against `baselines/v1.2.1/MANIFEST.md` first and failing
closed on a mismatch. The capture therefore requires no network access at all.

## Regenerating and verifying

```bash
node tools/baseline/seed-baseline-db.mjs --fetch-vendor    # one-off, needs network
node tools/baseline/seed-baseline-db.mjs --verify-vendor   # offline; disk vs index.json vs MANIFEST
```

`--fetch-vendor` overwrites these files and rewrites `index.json`. If any digest moves, the table in
`baselines/v1.2.1/MANIFEST.md` section 3 must be updated in the same commit, or `--verify-vendor`
fails — which is the intended behaviour: a silently-updated vendor directory is exactly the drift
this pinning exists to prevent.

`index.json` is the machine-readable index: source URL, local file, byte size, SHA-256, the fetch
date and the User-Agent used. The User-Agent matters — Google Fonts serves a different stylesheet
per browser, and the pin is `Chrome/120.0.0.0`, the Chromium version inside Electron 28.3.3.

## Two repository-level notes

- `eslint.config.js` excludes `tools/baseline/vendor/**` from linting. This is minified third-party
  code; linting it produces noise and no signal.
- `.gitattributes` marks `tools/baseline/vendor/**` as `-text` and `*.woff2` as `binary`. Without
  that, the tree-wide `eol=crlf` rule would check `tailwind.js` and the stylesheets out as CRLF and
  every SHA-256 in the manifest would fail to verify on a fresh clone.

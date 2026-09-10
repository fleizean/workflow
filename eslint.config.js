/*
 * Linter version (D-06, BUILD-13): eslint stays pinned at ^9.39.2 for this milestone.
 *
 * 9 is the `maintenance` dist-tag, not end-of-life - it still receives security fixes. npm prints
 * a deprecation warning for it on every install; that warning is the accepted, recorded cost.
 * The 10.x upgrade is deferred to milestone close because Phase 2 rewrites this whole surface and
 * Phase 3 adds the date rules that guard the only path which can destroy data the app does not
 * own (SHARED-03, the Sheets export). Moving the linter's major version underneath both is
 * optional churn on the gate whose job is to protect the migration. typescript-eslint@8.69 peers
 * eslint ^8 || ^9 || ^10, so nothing technical blocks the bump: the deferral is a risk decision,
 * not an obstacle, and it is recorded here so it is not re-derived.
 *
 * Coverage (BUILD-13, D-04, plan 02-04): every source extension in the tracked tree - .ts .mts
 * .cts .tsx .js .cjs .mjs .gs - is matched by a block below. tests/lint-coverage.test.ts asks the
 * linter itself, per tracked file, whether one of this repository's blocks matched it, so a new
 * extension or directory that nothing matches turns the suite red instead of passing unlinted.
 */
const globals = require('globals');
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = [
    // D-05 (plan 02-04): the three GSD tooling directories below were already present and are
    // verified here rather than re-added - Phase 1 deferred item 1 closes by that verification.
    // .claude/, .gsd/ and .planning/ are gitignored but still present on disk: they hold the
    // vendored GSD runtime, which is not this repository's source. Linting it produces ~1500
    // errors that drown the real signal, and CI never sees those files at all.
    {
        ignores: [
            // Build output and dependencies, never source. out/ is electron-vite's output
            // (plan 02-01); dist/ is electron-builder's.
            'dist/**', 'build/**', 'node_modules/**', 'out/**',
            // The GitHub Pages site - unrelated to the application (PROJECT.md, Out of Scope).
            'docs/**',
            // Phase 1's parity baselines (plans 01-05, 01-06), and the third-party CDN and font
            // bytes the capture replays. Those are pinned by SHA-256 in
            // baselines/v1.2.1/MANIFEST.md section 3, so linting one means editing it and breaking
            // its pin. tests/lint-coverage.test.ts accepts an ignored file under
            // tools/baseline/vendor/ only if tools/baseline/vendor/index.json pins it, so the
            // directory cannot become a place to hide unlinted repository code.
            'baselines/**', 'tools/baseline/vendor/**',
            '.claude/**', '.gsd/**', '.planning/**'
        ]
    },
    // D-04 (BUILD-13) - EXPIRES IN PHASE 7. The one exclusion here that covers code this
    // repository authors: the ~2,750 lines of inline <script> in src/pages/*.html.
    //   - Their defects are already catalogued individually as B1 through B13, with file and
    //     line, in RESTRUCTURE-BRIEF.md. Linting them buys a wall of known errors and no new
    //     information, and every fix would move the source Phase 8's parity diff is measured
    //     against.
    //   - The files are deleted in Phase 7's atomic cutover (D-01).
    //   - tests/lint-coverage.test.ts fails once src/pages/ no longer exists, so this entry
    //     cannot outlive its subject: delete it in the same change that deletes the directory.
    { ignores: ['src/pages/**'] },
    js.configs.recommended,
    {
        // BUILD-13 (plan 02-04): '**/*.gs' is google-apps-script.gs. The SpreadsheetApp,
        // ContentService and Logger globals below were declared for its benefit, but .gs was never
        // in a files pattern, so the deployed Apps Script had been silently unlinted all along.
        files: ['**/*.js', '**/*.cjs', '**/*.gs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.browser,
                ...globals.es2021,
                tailwind: 'readonly',
                SpreadsheetApp: 'readonly',
                ContentService: 'readonly',
                Logger: 'readonly'
            }
        },
        // D-10: these were all `warn`, so nothing ever failed the build. They must be `error`.
        rules: {
            semi: ['error', 'always'],
            // Phase 1 deferred item 3, closed by decision in plan 02-04: avoidEscape tolerates the
            // double-quoted string at src/renderer/bottom-nav.js:47, which itself contains single
            // quotes. The parity baselines are captured, so editing that file would now be
            // permitted - but the legacy tree is untouched until Phase 7's cutover (D-01) and the
            // file is deleted there either way. Keep avoidEscape; do not "fix" the line.
            quotes: ['error', 'single', { avoidEscape: true }],
            'no-unused-vars': ['error'],
            'no-console': 'off'
        }
    },
    // Plan 01-05 adds .mjs tooling scripts; lint them rather than leaving them silently exempt.
    {
        files: ['**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node }
        },
        rules: {
            semi: ['error', 'always'],
            quotes: ['error', 'single', { avoidEscape: true }],
            'no-unused-vars': ['error'],
            'no-console': 'off'
        }
    },
    // BUILD-13 (plan 02-04): .cts and .tsx join .ts and .mts in both TypeScript blocks, so the
    // typed rules, the explicit two-project parser setup (plan 02-01) and the custody rules below
    // all reach them. The project array stays explicit - the root tsconfig is a references-only
    // stub, and naming the two split configs is what makes typed linting deterministic.
    ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx'] })),
    {
        files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx'],
        languageOptions: {
            parserOptions: { project: ['./tsconfig.node.json', './tsconfig.web.json'], tsconfigRootDir: __dirname },
            globals: { ...globals.node }
        },
        rules: {
            semi: ['error', 'always'],
            quotes: ['error', 'single', { avoidEscape: true }],
            // CUSTODY-02, defence in depth beyond the unit test
            'no-restricted-properties': ['error',
                {
                    object: 'app', property: 'setPath',
                    message: 'Moving userData orphans every existing krono.db (CUSTODY-02).'
                },
                {
                    object: 'app', property: 'setName',
                    message: 'app.name determines userData; renaming orphans every krono.db (CUSTODY-02).'
                }
            ],
            // CUSTODY-03. Deliberate exceptions: restoreDatabase() and the fixture copier,
            // each with an inline eslint-disable-next-line naming the reason.
            'no-restricted-syntax': ['error', {
                selector: 'CallExpression[callee.object.name=\'fs\'][callee.property.name=/^(copyFile|copyFileSync|cp|cpSync|rename|renameSync)$/]',
                message: 'Never copy a live SQLite database — use db.backup() (CUSTODY-03).'
            }]
        }
    },
    // BUILD-13 (plan 02-04): plan 02-03 wrote the repository's first .tsx files - the renderer
    // shell - and no block matched them. The typed rules and the custody rules reach .tsx through
    // the two TypeScript blocks above; this block adds only what differs for the renderer: JSX
    // parsing and the browser globals it runs against.
    {
        files: ['**/*.tsx'],
        languageOptions: {
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: { ...globals.browser }
        }
    },
    // The same two custody rules, for the JS/CJS/MJS half of the tree (plan 01-04).
    //
    // Plan 01-02 scoped them to .ts/.mts only, which left every tooling script exempt from the
    // rules the phase exists to enforce — and the tooling scripts are exactly where the tempting
    // fs.copyFileSync of a database lives (tools/baseline/archive-real-db.mjs), plus the
    // app.setPath that plan 01-05's tools/baseline/entry.cjs may need. A guard that does not
    // cover the file where the violation is plausible is not defence in depth.
    //
    // Verified at the time of writing: zero existing call sites in any .js/.cjs/.mjs in this
    // repository, so this widens coverage without changing any current lint outcome.
    //
    // Plan 02-04 adds .gs, for the same reason: every source file resolves both custody rules, and
    // tests/lint-coverage.test.ts asserts it per file.
    {
        files: ['**/*.js', '**/*.cjs', '**/*.mjs', '**/*.gs'],
        rules: {
            // CUSTODY-02
            'no-restricted-properties': ['error',
                {
                    object: 'app', property: 'setPath',
                    message: 'Moving userData orphans every existing krono.db (CUSTODY-02).'
                },
                {
                    object: 'app', property: 'setName',
                    message: 'app.name determines userData; renaming orphans every krono.db (CUSTODY-02).'
                }
            ],
            // CUSTODY-03. Deliberate exceptions carry an inline eslint-disable-next-line naming
            // the reason — see the copy site in tools/baseline/archive-real-db.mjs.
            'no-restricted-syntax': ['error', {
                selector: 'CallExpression[callee.object.name=\'fs\'][callee.property.name=/^(copyFile|copyFileSync|cp|cpSync|rename|renameSync)$/]',
                message: 'Never copy a live SQLite database — use db.backup() (CUSTODY-03).'
            }]
        }
    },
    // Plan 02-04 - the layering rule. src/lib/** and src/shared/** must load in plain Node under
    // Vitest, with no Electron: src/lib/db/backup.ts was written to demonstrate that property and
    // src/lib/db/client.ts inherits it - every path is injected, nothing is derived from `app`.
    // An electron import is the one edit that silently ends it: the module still type-checks,
    // and fails only when Vitest tries to load a runtime that is not there.
    //
    // The globs end in /** on purpose. ESLint treats such a pattern as applying only to files an
    // extension-specific block has already matched, so this adds a rule to the .ts files under
    // these directories without dragging their .sql or .json files into lint.
    {
        files: ['src/lib/**', 'src/shared/**'],
        rules: {
            'no-restricted-imports': ['error', {
                paths: [{
                    name: 'electron',
                    message: 'src/lib and src/shared must stay loadable in plain Node under Vitest - inject the dependency instead of importing electron.'
                }],
                patterns: [{
                    group: ['electron/*'],
                    message: 'src/lib and src/shared must stay loadable in plain Node under Vitest - inject the dependency instead of importing electron.'
                }]
            }]
        }
    }
];

const globals = require('globals');
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = [
    // BUILD-13 will widen this in Phase 2. Today it must at minimum stop excluding .ts.
    // .claude/, .gsd/ and .planning/ are gitignored but still present on disk: they hold the
    // vendored GSD runtime, which is not this repository's source. Linting it produces ~1500
    // errors that drown the real signal, and CI never sees those files at all.
    {
        ignores: [
            'dist/**', 'build/**', 'node_modules/**', 'docs/**', 'out/**',
            'baselines/**', 'tools/baseline/vendor/**',
            '.claude/**', '.gsd/**', '.planning/**'
        ]
    },
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.cjs'],
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
    ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: ['**/*.ts', '**/*.mts'] })),
    {
        files: ['**/*.ts', '**/*.mts'],
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
    {
        files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
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
    }
];

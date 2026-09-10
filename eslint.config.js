// eslint stays on 9 until milestone close (Phase 2 D-06). Flat config replaces a rule's options wholesale, so every
// restricted-* list is composed from the constants below and each selector is declared once (D-11).
const globals = require('globals');
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

const CUSTODY_02 = [
    {
        object: 'app', property: 'setPath',
        message: 'Moving userData orphans every existing krono.db (CUSTODY-02).'
    },
    {
        object: 'app', property: 'setName',
        message: 'app.name determines userData; renaming orphans every krono.db (CUSTODY-02).'
    }
];

// Deliberate exceptions carry an eslint-disable-next-line naming the reason.
const CUSTODY_03 = {
    selector: 'CallExpression[callee.object.name=\'fs\'][callee.property.name=/^(copyFile|copyFileSync|cp|cpSync|rename|renameSync)$/]',
    message: 'Never copy a live SQLite database — use db.backup() (CUSTODY-03).'
};

const DATE_MESSAGE = 'Calendar dates go through src/shared/utils/date.ts (SHARED-03).';
const DATE_BANS = [
    "MemberExpression[property.name='toISOString']",
    "MemberExpression[computed=true][property.value='toISOString']",
    "MemberExpression[object.name='Date'][property.name='parse']",
    "MemberExpression[object.name='Date'][computed=true][property.value='parse']",
    "NewExpression[callee.name='Date'][arguments.length=1]",
    "NewExpression[callee.name='Date'] > SpreadElement",
    'MemberExpression[property.name=/^getUTC(FullYear|Month|Date|Day)$/]',
    'ObjectPattern > Property[key.name=/^(toISOString|getUTCFullYear|getUTCMonth|getUTCDate|getUTCDay)$/]',
    "VariableDeclarator[init.name='Date'] > ObjectPattern > Property[key.name='parse']"
].map((selector) => ({ selector, message: DATE_MESSAGE }));
const LEGACY_DATE_EXEMPT = ['main.js', 'database/db.js', 'src/renderer/shared.js', 'src/renderer/timer.js'];
const FROZEN_DATE_EXEMPT = ['google-apps-script.gs'];

const PROCESS_ENV = { object: 'process', property: 'env', message: 'Read configuration from src/main/config.ts (D-23).' };
const PROCESS_ARGV = { object: 'process', property: 'argv', message: 'Read launch flags from src/main/config.ts (D-23).' };

module.exports = [
    // .claude/, .gsd/ and .planning/ hold the gitignored GSD runtime, not this repository's source.
    // tools/baseline/vendor/** holds third-party bytes pinned by SHA-256 in tools/baseline/vendor/index.json.
    {
        ignores: [
            'dist/**', 'build/**', 'node_modules/**', 'out/**',
            'docs/**',
            'baselines/**', 'tools/baseline/vendor/**',
            '.claude/**', '.gsd/**', '.planning/**'
        ]
    },
    // EXPIRES IN PHASE 7: the legacy inline scripts, deleted in the cutover (tests/lint-coverage.test.ts tripwires it).
    { ignores: ['src/pages/**'] },
    { linterOptions: { reportUnusedDisableDirectives: 'error' } },
    js.configs.recommended,
    {
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
        rules: {
            semi: ['error', 'always'],
            // avoidEscape tolerates src/renderer/bottom-nav.js:47; the legacy tree stays untouched until Phase 7.
            quotes: ['error', 'single', { avoidEscape: true }],
            'no-unused-vars': ['error'],
            'no-console': 'off'
        }
    },
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
    // The root tsconfig is a references-only stub; naming both split configs keeps typed linting deterministic.
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
            'no-restricted-properties': ['error', ...CUSTODY_02],
            'no-restricted-syntax': ['error', CUSTODY_03, ...DATE_BANS]
        }
    },
    {
        files: ['**/*.tsx'],
        languageOptions: {
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: { ...globals.browser }
        }
    },
    {
        files: ['**/*.js', '**/*.cjs', '**/*.mjs', '**/*.gs'],
        rules: {
            'no-restricted-properties': ['error', ...CUSTODY_02],
            'no-restricted-syntax': ['error', CUSTODY_03, ...DATE_BANS]
        }
    },
    // The sanctioned home of the date constructs keeps CUSTODY-03 alone (D-13).
    {
        files: ['src/shared/utils/date.ts'],
        rules: {
            'no-restricted-syntax': ['error', CUSTODY_03]
        }
    },
    // Legacy entries expire in Phase 7 (Phase 2 D-01 forbids editing them); the Apps Script is frozen by the brief.
    {
        files: [...LEGACY_DATE_EXEMPT, ...FROZEN_DATE_EXEMPT],
        rules: {
            'no-restricted-syntax': ['error', CUSTODY_03]
        }
    },
    {
        files: ['src/**/*.ts', 'src/**/*.mts', 'src/**/*.cts', 'src/**/*.tsx'],
        rules: {
            'no-restricted-properties': ['error', ...CUSTODY_02, PROCESS_ENV, PROCESS_ARGV]
        }
    },
    // The one sanctioned env/argv reader restates CUSTODY-02 alone (D-23).
    {
        files: ['src/main/config.ts'],
        rules: {
            'no-restricted-properties': ['error', ...CUSTODY_02]
        }
    },
    // src/lib and src/shared must load in plain Node under Vitest. A /** glob only adds rules to files an
    // extension block already matched, so .sql and .json stay out of lint.
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

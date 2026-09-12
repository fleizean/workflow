// eslint stays on 9 until milestone close (Phase 2 D-06). Flat config replaces a rule's options wholesale, so every
// restricted-* list is composed from the constants below and each selector is declared once (D-11).
const globals = require('globals');
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const { builtinModules } = require('node:module');

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
    // toJSON() returns toISOString(), the same UTC-day trap (WR-03).
    "MemberExpression[property.name='toJSON']",
    "MemberExpression[computed=true][property.value='toJSON']",
    "MemberExpression[object.name='Date'][property.name='parse']",
    "MemberExpression[object.name='Date'][computed=true][property.value='parse']",
    "NewExpression[callee.name='Date'][arguments.length=1]",
    "NewExpression[callee.name='Date'] > SpreadElement",
    'MemberExpression[property.name=/^getUTC(FullYear|Month|Date|Day)$/]',
    'ObjectPattern > Property[key.name=/^(toISOString|toJSON|getUTCFullYear|getUTCMonth|getUTCDate|getUTCDay)$/]',
    "VariableDeclarator[init.name='Date'] > ObjectPattern > Property[key.name='parse']"
].map((selector) => ({ selector, message: DATE_MESSAGE }));
const LEGACY_DATE_EXEMPT = ['main.js', 'database/db.js', 'src/renderer/shared.js', 'src/renderer/timer.js'];

const PROCESS_ENV = { object: 'process', property: 'env', message: 'Read configuration from src/main/config.ts (D-23).' };
const PROCESS_ARGV = { object: 'process', property: 'argv', message: 'Read launch flags from src/main/config.ts (D-23).' };

const ELECTRON_MESSAGE = 'src/lib and src/shared must stay loadable in plain Node under Vitest - inject the dependency instead of importing electron.';
const ELECTRON_PATHS = [{ name: 'electron', message: ELECTRON_MESSAGE }];
const ELECTRON_PATTERNS = [{ group: ['electron/*'], message: ELECTRON_MESSAGE }];

const DRIZZLE_TOOLING_MESSAGE = 'drizzle-kit and the drizzle migrators are authoring tooling; the project runner alone applies migrations (D-08).';
const DRIZZLE_TOOLING_PATHS = [{ name: 'drizzle-kit', message: DRIZZLE_TOOLING_MESSAGE }];
const DRIZZLE_TOOLING_PATTERNS = [{
    group: ['drizzle-kit/*', 'drizzle-orm/migrator', 'drizzle-orm/*/migrator', 'drizzle-orm/**/migrator'],
    message: DRIZZLE_TOOLING_MESSAGE
}];

// ARCH-01: a service must load with electron stubbed to throw, and must not know that IPC exists. Ports in, handlers
// above: a service that imports ipc/ has inverted the layering even when nothing else notices.
const SERVICE_LAYER_MESSAGE = 'src/main/services must stay Electron-free and must not import ipc/ - take a port from src/main/ports and let a handler call the service (ARCH-01).';
const SERVICE_LAYER_PATHS = [{ name: 'electron', message: SERVICE_LAYER_MESSAGE }];
const SERVICE_LAYER_PATTERNS = [
    { group: ['electron/*'], message: SERVICE_LAYER_MESSAGE },
    { regex: '^(\\.\\./)+ipc(/|$)', message: SERVICE_LAYER_MESSAGE },
    { regex: '^@main/ipc(/|$)', message: SERVICE_LAYER_MESSAGE },
    { regex: '(^|/)main/ipc(/|$)', message: SERVICE_LAYER_MESSAGE }
];

// ARCH-01 / CORE-16: Drizzle is how src/lib/db writes SQL; a value import of it anywhere else is SQL somewhere else.
// Types are allowed, so a caller may still name a row shape the schema derives.
const DRIZZLE_VALUE_MESSAGE = 'Drizzle and the SQL it builds live only under src/lib/db; call a repository (ARCH-01, CORE-16).';
const DRIZZLE_VALUE_PATHS = [{ name: 'drizzle-orm', message: DRIZZLE_VALUE_MESSAGE, allowTypeImports: true }];
const DRIZZLE_VALUE_PATTERNS = [
    { group: ['drizzle-orm/*', 'drizzle-orm/**'], message: DRIZZLE_VALUE_MESSAGE, allowTypeImports: true }
];

const SQL_MESSAGE = 'SQL lives only under src/lib/db; call a repository (ARCH-01, CORE-16).';
const SQL_BANS = [
    // Drizzle's sql`` tag, whatever local name it is imported under.
    'TaggedTemplateExpression[tag.name=\'sql\']',
    'TaggedTemplateExpression[tag.property.name=\'sql\']',
    // better-sqlite3's statement API. exec is matched only on a literal argument, which leaves the regex exec(value)
    // shape src/shared/utils/date.ts uses alone; a regex exec on a literal is refused too, and is the known cost.
    'CallExpression[callee.property.name=\'prepare\']',
    'CallExpression[callee.property.name=\'pragma\']',
    'CallExpression[callee.property.name=\'exec\'][arguments.0.type=\'Literal\']',
    'CallExpression[callee.property.name=\'exec\'][arguments.0.type=\'TemplateLiteral\']'
].map((selector) => ({ selector, message: SQL_MESSAGE }));
// The two bootstrap files that operate the database file itself: D-32's wal_checkpoint before the close, and
// BUILD-06's packaged proof, which writes and reads one row in a brand-new injected database.
const SQL_BOOTSTRAP_EXEMPT = ['src/main/database-startup.ts', 'src/main/smoke.ts'];

const SHARED_LAYER_MESSAGE = 'src/shared is the bottom layer: no main/lib/preload/renderer, no node builtins, no electron, no database driver (D-15).';
const SHARED_LAYER_PATHS = [
    ...ELECTRON_PATHS,
    { name: 'better-sqlite3', message: SHARED_LAYER_MESSAGE },
    ...builtinModules.map((name) => ({ name, message: SHARED_LAYER_MESSAGE }))
];
const SHARED_LAYER_PATTERNS = [
    ...ELECTRON_PATTERNS,
    { regex: '^node:', message: SHARED_LAYER_MESSAGE },
    { regex: '^(\\.\\./)+(main|lib|preload|renderer)(/|$)', message: SHARED_LAYER_MESSAGE },
    { regex: '^@(main|lib|renderer)(/|$)', message: SHARED_LAYER_MESSAGE }
];

const ZOD_TYPE_ONLY_MESSAGE = 'zod is value-imported only in src/shared/schemas and src/shared/ipc; use import type here (SHARED-07).';
const ZOD_TYPE_ONLY_PATH = { name: 'zod', message: ZOD_TYPE_ONLY_MESSAGE, allowTypeImports: true };
const ZOD_BEARING_SHARED_PATTERNS = [
    { regex: '^@shared/(schemas|ipc)(/|$)', message: ZOD_TYPE_ONLY_MESSAGE, allowTypeImports: true },
    { regex: '(^|/)shared/(schemas|ipc)(/|$)', message: ZOD_TYPE_ONLY_MESSAGE, allowTypeImports: true }
];
// Inside src/shared the zod-bearing modules are also reachable as siblings, e.g. '../schemas' (WR-02).
const ZOD_BEARING_SIBLING_PATTERN = { regex: '^(\\.\\./)+(schemas|ipc)(/|$)', message: ZOD_TYPE_ONLY_MESSAGE, allowTypeImports: true };
// allowTypeImports accepts an all-inline `import { type X }`, which still loads the module; these two refuse it (Pitfall 5).
const TYPE_IMPORT_RULES = {
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }],
    '@typescript-eslint/no-import-type-side-effects': 'error'
};

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
                tailwind: 'readonly'
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
    // ARCH-01: SQL lives only under src/lib/db. Each block below restates every ban it does not lift (D-11).
    {
        files: ['src/**'],
        rules: {
            'no-restricted-syntax': ['error', CUSTODY_03, ...DATE_BANS, ...SQL_BANS]
        }
    },
    // The one home of SQL.
    {
        files: ['src/lib/db/**'],
        rules: {
            'no-restricted-syntax': ['error', CUSTODY_03, ...DATE_BANS]
        }
    },
    {
        files: SQL_BOOTSTRAP_EXEMPT,
        rules: {
            'no-restricted-syntax': ['error', CUSTODY_03, ...DATE_BANS]
        }
    },
    // The sanctioned home of the date constructs keeps CUSTODY-03 alone (D-13).
    {
        files: ['src/shared/utils/date.ts'],
        rules: {
            'no-restricted-syntax': ['error', CUSTODY_03, ...SQL_BANS]
        }
    },
    // Legacy entries expire in Phase 7 (Phase 2 D-01 forbids editing them). main.js and database/db.js are the
    // v1.2.1 SQL this milestone is replacing, so they are outside the SQL bans too.
    {
        files: LEGACY_DATE_EXEMPT,
        rules: {
            'no-restricted-syntax': ['error', CUSTODY_03]
        }
    },
    // The two legacy files under src/ hold no SQL, so the block above lifting the date bans must not lift those too.
    {
        files: ['src/renderer/shared.js', 'src/renderer/timer.js'],
        rules: {
            'no-restricted-syntax': ['error', CUSTODY_03, ...SQL_BANS]
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
    // A /** glob only adds rules to files an extension block already matched, so .sql, .json and .css stay out of lint.
    // D-08 reaches src/main, src/preload and src/renderer here; the more specific blocks below restate it.
    {
        files: ['src/**'],
        rules: {
            'no-restricted-imports': ['error', { paths: DRIZZLE_TOOLING_PATHS, patterns: DRIZZLE_TOOLING_PATTERNS }]
        }
    },
    // The typed rule is named by extension: a .js file under src/ never matches a tseslint block, so the plugin
    // would not be defined for it.
    {
        files: ['src/**/*.ts', 'src/**/*.mts', 'src/**/*.cts', 'src/**/*.tsx'],
        rules: {
            '@typescript-eslint/no-restricted-imports': ['error', {
                paths: [...DRIZZLE_TOOLING_PATHS, ...DRIZZLE_VALUE_PATHS],
                patterns: [...DRIZZLE_TOOLING_PATTERNS, ...DRIZZLE_VALUE_PATTERNS]
            }]
        }
    },
    // src/lib keeps node:fs, node:path and the driver; only src/shared gets the layer bans (Pitfall 2).
    {
        files: ['src/lib/**'],
        rules: {
            'no-restricted-imports': ['error', {
                paths: [...ELECTRON_PATHS, ...DRIZZLE_TOOLING_PATHS],
                patterns: [...ELECTRON_PATTERNS, ...DRIZZLE_TOOLING_PATTERNS]
            }]
        }
    },
    // The one place Drizzle may be imported as a value; the authoring-tooling ban stays (D-08).
    {
        files: ['src/lib/db/**/*.ts'],
        rules: {
            '@typescript-eslint/no-restricted-imports': ['error', {
                paths: DRIZZLE_TOOLING_PATHS,
                patterns: DRIZZLE_TOOLING_PATTERNS
            }]
        }
    },
    // ARCH-01, criterion 3: the Electron-free service boundary, stated as lint rather than as a convention.
    {
        files: ['src/main/services/**'],
        rules: {
            'no-restricted-imports': ['error', {
                paths: [...SERVICE_LAYER_PATHS, ...DRIZZLE_TOOLING_PATHS],
                patterns: [...SERVICE_LAYER_PATTERNS, ...DRIZZLE_TOOLING_PATTERNS]
            }]
        }
    },
    {
        files: ['src/shared/**'],
        rules: {
            'no-restricted-imports': ['error', {
                paths: [...SHARED_LAYER_PATHS, ...DRIZZLE_TOOLING_PATHS],
                patterns: [...SHARED_LAYER_PATTERNS, ...DRIZZLE_TOOLING_PATTERNS]
            }]
        }
    },
    {
        files: ['src/shared/utils/**', 'src/shared/constants/**', 'src/shared/types/**'],
        rules: {
            '@typescript-eslint/no-restricted-imports': ['error', {
                paths: [ZOD_TYPE_ONLY_PATH, ...DRIZZLE_TOOLING_PATHS, ...DRIZZLE_VALUE_PATHS],
                patterns: [
                    ...ZOD_BEARING_SHARED_PATTERNS, ZOD_BEARING_SIBLING_PATTERN, ...DRIZZLE_TOOLING_PATTERNS,
                    ...DRIZZLE_VALUE_PATTERNS
                ]
            }],
            ...TYPE_IMPORT_RULES
        }
    },
    {
        files: ['src/renderer/src/**'],
        rules: {
            '@typescript-eslint/no-restricted-imports': ['error', {
                paths: [ZOD_TYPE_ONLY_PATH, ...DRIZZLE_TOOLING_PATHS, ...DRIZZLE_VALUE_PATHS],
                patterns: [...ZOD_BEARING_SHARED_PATTERNS, ...DRIZZLE_TOOLING_PATTERNS, ...DRIZZLE_VALUE_PATTERNS]
            }],
            ...TYPE_IMPORT_RULES
        }
    }
];

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
const LEGACY_DATE_EXEMPT = ['main.js', 'database/db.js'];

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

/*
 * ARCH-01: a service must load with electron stubbed to throw, must not know that IPC exists, and must not reach the
 * database, the adapters or the composition root. Ports in, handlers above, repositories handed to it as arguments.
 *
 * WR-05: until this rule grew, only `electron` was ever flagged here - `better-sqlite3`, `@lib/db`, `../../lib/db`,
 * `../adapters`, `../window` and `../container` were all accepted, while five service files carried a comment saying
 * "nothing here imports src/lib/db". A rule five files quote and nothing checks is a comment.
 *
 * The ban covers the type position too. Every service states what it needs structurally on purpose - naming
 * SessionsRepository is taking a dependency on the row layer's vocabulary - so there is no type import to exempt, and
 * an exemption is how the value import comes back.
 */
const SERVICE_LAYER_MESSAGE = 'src/main/services must stay Electron-free, must not import ipc/, and must not reach the database, the adapters or the composition root - take a port from src/main/ports, state what you need structurally, and let the container hand it to you (ARCH-01).';
const SERVICE_LAYER_PATHS = [
    { name: 'electron', message: SERVICE_LAYER_MESSAGE },
    { name: 'better-sqlite3', message: SERVICE_LAYER_MESSAGE }
];
const SERVICE_LAYER_PATTERNS = [
    { group: ['electron/*'], message: SERVICE_LAYER_MESSAGE },
    { regex: '^(\\.\\./)+ipc(/|$)', message: SERVICE_LAYER_MESSAGE },
    { regex: '^@main/ipc(/|$)', message: SERVICE_LAYER_MESSAGE },
    { regex: '(^|/)main/ipc(/|$)', message: SERVICE_LAYER_MESSAGE },
    // Everything under src/main that a service sits above, plus the database in either spelling. ports/ and the
    // sibling services are deliberately absent: those are the only two neighbours a service may name.
    {
        regex: '^(\\.\\./)+(lib|adapters|window|tray|container|lifecycle|database-startup|legacy-storage|config)(/|$)',
        message: SERVICE_LAYER_MESSAGE
    },
    { regex: '^@main/(adapters|window|tray|container|lifecycle|config)(/|$)', message: SERVICE_LAYER_MESSAGE },
    { regex: '^@lib(/|$)', message: SERVICE_LAYER_MESSAGE },
    { regex: '(^|/)lib/db(/|$)', message: SERVICE_LAYER_MESSAGE }
];

// ARCH-01: a handler validates, calls one service and shapes the answer. It may name electron - ipcMain is how a
// handler is reached - but not the database, not a repository and not an adapter: a handler that reaches past the
// services is a handler with logic in it, and the logic would sit where no unit test can see it.
const IPC_LAYER_MESSAGE = 'src/main/ipc takes the shared contract and the services the container holds; the database, the repositories and the adapters sit below it (ARCH-01).';
const IPC_LAYER_PATHS = [{ name: 'better-sqlite3', message: IPC_LAYER_MESSAGE }];
const IPC_LAYER_PATTERNS = [
    { regex: '^(\\.\\./)+lib(/|$)', message: IPC_LAYER_MESSAGE },
    { regex: '^@lib(/|$)', message: IPC_LAYER_MESSAGE },
    { regex: '(^|/)lib/db(/|$)', message: IPC_LAYER_MESSAGE },
    { regex: '^(\\.\\./)+adapters(/|$)', message: IPC_LAYER_MESSAGE },
    { regex: '^@main/adapters(/|$)', message: IPC_LAYER_MESSAGE }
];

/*
 * ARCH-01's fourth clause, as lint rather than as a habit: outside the bootstrap, the window, the lifecycle, the
 * tray, ipc/ and the adapters that exist to wrap it, an Electron API reaches src/main through a port. The rule is an
 * allowlist because the phase-5 verifier found the clause true only by construction - nothing failed the day a new
 * main module reached for electron instead of writing a port.
 */
const MAIN_ELECTRON_MESSAGE = 'Electron reaches src/main through a port in src/main/ports with an adapter in src/main/adapters; only the bootstrap, window, lifecycle, tray, ipc/ and the adapters themselves import it directly (ARCH-01).';
const MAIN_ELECTRON_PATHS = [{ name: 'electron', message: MAIN_ELECTRON_MESSAGE }];
const MAIN_ELECTRON_PATTERNS = [{ group: ['electron/*'], message: MAIN_ELECTRON_MESSAGE }];
// The shell itself, plus three that predate the ports and are named rather than left to be discovered:
// userdata-path and legacy-storage are Phase 2/4 bootstrap that runs before any container exists, and smoke.ts is
// BUILD-06's packaged prover, which drives the real app rather than being part of it.
const MAIN_ELECTRON_ALLOWED = [
    'src/main/index.ts', 'src/main/window.ts', 'src/main/lifecycle.ts', 'src/main/tray.ts',
    'src/main/ipc/**', 'src/main/adapters/**',
    'src/main/userdata-path.ts', 'src/main/legacy-storage.ts', 'src/main/smoke.ts'
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

/*
 * SPA-11 (trap C3): a class name that exists only after a concatenation is a class name the build never saw.
 * v1.2.1 got away with `bg-${color}-100` at fourteen sites because the Tailwind Play CDN generates CSS by watching
 * the live DOM; build-time Tailwind reads the SOURCE instead, so those names emit no CSS at all and the element
 * renders uncoloured. Nothing else catches it - it typechecks, it renders, and only the pixels are wrong.
 *
 * A safelist would silence this rule and keep the bug. The sanctioned shape is a typed lookup map whose values are
 * whole class strings, which is what src/renderer/src/components/ui/AlertDialog.tsx does.
 */
const CLASS_BUILD_MESSAGE = 'Write class names out in full and select between them with a typed lookup map; a name assembled at run time gets no CSS from a build-time Tailwind (SPA-11, C3).';
const CLASS_ATTRIBUTES = 'JSXAttribute[name.name=/^(className|class)$/] ';
const CLASS_LIST = [
    "CallExpression[callee.object.property.name='classList']",
    "CallExpression[callee.object.name='classList']"
];

/*
 * CR-02: a literal that is a Tailwind utility waiting for its next piece - 'bg-', 'text-', 'rounded-full bg-',
 * 'hover:'. Anchoring only on the className attribute left the most natural refactor of a banned line wide open:
 * hoist the concatenation to a local and pass the variable. This matches the literal wherever it is concatenated,
 * so the hoist, the spread-props object and setAttribute are one rule rather than three.
 *
 * The roots are an allowlist rather than a shape, because a shape catches ids too: AlertDialog builds
 * 'dialog-title-' + id, and reaching an element by its id is the sanctioned way.
 */
const CLASS_ROOT = '(?:bg|text|border|ring|from|via|to|fill|stroke|shadow|outline|decoration|accent|caret|divide' +
    '|placeholder|w|h|min-w|max-w|min-h|max-h|p[xytblr]?|m[xytblr]?|gap|space-[xy]|top|left|right|bottom|inset|z' +
    '|opacity|rounded|grid-cols|grid-rows|col-span|row-span|order|basis|translate-[xy]|scale|rotate|duration' +
    '|delay|animate|font|tracking|leading|hover|focus|active|disabled|dark|group-hover|sm|md|lg|xl|2xl)';
const CLASS_PREFIX = '/^(?:[-a-z0-9:]+ )*' + CLASS_ROOT + '[-:]$/';

const CLASS_BUILD_BANS = [
    CLASS_ATTRIBUTES + 'TemplateLiteral[expressions.length>0]',
    CLASS_ATTRIBUTES + "BinaryExpression[operator='+']",
    // A class list joined or concatenated is a class list the scanner never saw.
    CLASS_ATTRIBUTES + 'CallExpression[callee.property.name=/^(join|concat)$/]',
    // The utility prefix itself, wherever it is being appended to. This is what reaches the hoisted local.
    "BinaryExpression[operator='+'] > Literal[value=" + CLASS_PREFIX + ']',
    'TemplateLiteral[expressions.length>0] > TemplateElement[value.raw=' + CLASS_PREFIX + ']',
    'MemberExpression[property.name=/^(join|concat)$/] > ArrayExpression > Literal[value=' + CLASS_PREFIX + ']',
    "MemberExpression[property.name='concat'] > Literal[value=" + CLASS_PREFIX + ']',
    // The imperative spellings, which is how the v1.2.1 renderer wrote them.
    "AssignmentExpression[left.property.name='className'][right.type='TemplateLiteral'][right.expressions.length>0]",
    "AssignmentExpression[left.property.name='className'][right.type='BinaryExpression'][right.operator='+']",
    "AssignmentExpression[left.property.name='className'] > CallExpression[callee.property.name=/^(join|concat)$/]",
    ...CLASS_LIST.flatMap((call) => [
        call + ' > TemplateLiteral[expressions.length>0]',
        call + " > BinaryExpression[operator='+']",
        call + ' > CallExpression[callee.property.name=/^(join|concat)$/]',
        // Spread into classList: nothing can tell what it will contain, so it is refused outright.
        call + ' > SpreadElement'
    ]),
    // setAttribute('class', ...) is className under another name, and nothing in this renderer needs it.
    "CallExpression[callee.property.name='setAttribute'][arguments.0.value='class']"
].map((selector) => ({ selector, message: CLASS_BUILD_MESSAGE }));

/*
 * SPA-13 (Y2). legacy/pages/settings.html:659 reached the DELETE-ALL-DATA button with
 * document.querySelector('.mt-8.mb-8 button') - a spacing tweak detaches it, and the failure is a button that
 * silently stops working. The ban is on any class selector, not on a list of Tailwind-looking ones: ARCH-05 leaves
 * no other kind of class in this renderer, so a dot in a selector string is a utility class by construction. An
 * attribute or id selector carries no dot and is left alone; so is a dynamic selector, which is banned outright
 * because nothing can tell what it will contain.
 */
const CLASS_QUERY_MESSAGE = 'Reach an element with a ref, an id or a data attribute - never by its utility classes, which are layout that moves (SPA-13, Y2).';
const CLASS_QUERY_METHODS = '[callee.property.name=/^(querySelector|querySelectorAll|closest|matches)$/]';
const CLASS_QUERY_BANS = [
    'CallExpression' + CLASS_QUERY_METHODS + '[arguments.0.value=/\\./]',
    'CallExpression' + CLASS_QUERY_METHODS + ' > TemplateLiteral[expressions.length>0]',
    'CallExpression[callee.name=/^(querySelector|querySelectorAll)$/][arguments.0.value=/\\./]',
    /*
     * WR-01: the comment above says a dynamic selector is banned outright because nothing can tell what it will
     * contain, and that was true only of template literals. A selector hoisted to a constant - which is what a
     * reviewer asks for when the string is long - and a selector built with + were both accepted, and the hoisted
     * one is legacy/pages/settings.html:659 verbatim.
     */
    'CallExpression' + CLASS_QUERY_METHODS + ' > Identifier',
    'CallExpression' + CLASS_QUERY_METHODS + " > BinaryExpression[operator='+']",
    // The class attribute reached as an attribute selector, which carries no dot.
    'CallExpression' + CLASS_QUERY_METHODS + '[arguments.0.value=/\\[\\s*class\\s*[~^$*|]?=/]',
    'CallExpression[callee.name=/^(querySelector|querySelectorAll)$/][arguments.0.value=/\\[\\s*class\\s*[~^$*|]?=/]',
    // No selector at all: the argument is the class list itself.
    "CallExpression[callee.property.name='getElementsByClassName']"
].map((selector) => ({ selector, message: CLASS_QUERY_MESSAGE }));

/*
 * ARCH-05's third clause - "no per-component class rule" - reaches only rules written inside globals.css, and a
 * stylesheet does not have to be a file. WR-04: a <style> element with a rule in it is exactly what
 * legacy/renderer/shared.js:255-285 did for the toast transition, and replacing it with @theme tokens is the change
 * 07-E-SUMMARY.md presents as ARCH-05's whole point. Nothing stopped it coming back, and the imperative routes to a
 * per-element style were open too.
 */
const ARCH_05_MESSAGE = 'Styling is Tailwind utilities on components: one stylesheet, no rule injected at run time and no inline style. A value Tailwind cannot express is an @theme token (ARCH-05).';
const STYLE_INJECTION_BANS = [
    // The <style> element, in JSX and built by hand.
    "JSXOpeningElement[name.name='style']",
    "CallExpression[callee.property.name='createElement'][arguments.0.value='style']",
    "CallExpression[callee.property.name='createElement'][arguments.0.value='link']",
    // A rule pushed straight into a live sheet.
    'CallExpression[callee.property.name=/^(insertRule|addRule)$/]',
    "MemberExpression[property.name='adoptedStyleSheets']",
    "NewExpression[callee.name='CSSStyleSheet']",
    // The per-element style, which the JSX attribute ban already covers in its declarative spelling.
    "AssignmentExpression[left.object.property.name='style']",
    "CallExpression[callee.object.property.name='style'][callee.property.name=/^(setProperty|cssText)$/]",
    "AssignmentExpression[left.property.name='cssText']",
    "CallExpression[callee.property.name='setAttribute'][arguments.0.value='style']"
].map((selector) => ({ selector, message: ARCH_05_MESSAGE }));

/*
 * ARCH-03, criterion 7: the renderer's direction of flow, as lint rather than as a convention.
 *
 * Phase 7 slice A asserted these directions against the source tree, which catches them only where a test thought
 * to look. Here each one is a rule the linter applies to every renderer file, and each is lifted in exactly the
 * places ARCH-03 names - so the allowlist is the architecture, written once.
 */
const RENDERER_FACADE_MESSAGE = 'The preload bridge is opened in lib/ipc.ts and called from features/<domain>/api or app/providers; everywhere else takes the data from a hook (ARCH-03).';
const RENDERER_FACADE_PATHS = [{ name: '@shared/constants/bridge', message: RENDERER_FACADE_MESSAGE }];
const RENDERER_FACADE_PATTERNS = [
    { regex: '(^|/)lib/ipc$', message: RENDERER_FACADE_MESSAGE },
    // A sibling inside lib/ reaching the facade directly.
    { regex: '^\\./ipc$', message: RENDERER_FACADE_MESSAGE }
];

const RENDERER_QUERY_MESSAGE = 'Server state lives in a features/<domain>/api hook or in app/providers; a component reads it through the feature, never off the client (ARCH-03).';
const RENDERER_QUERY_PATHS = [
    { name: '@tanstack/react-query', message: RENDERER_QUERY_MESSAGE, allowTypeImports: true }
];
const RENDERER_QUERY_PATTERNS = [
    { group: ['@tanstack/react-query/*'], message: RENDERER_QUERY_MESSAGE, allowTypeImports: true }
];

const RENDERER_STORE_MESSAGE = 'A Zustand store is either global UI state in store/ or one feature\'s own state in features/<domain>/state - the four kinds of state stay apart (ARCH-03).';
const RENDERER_STORE_PATHS = [{ name: 'zustand', message: RENDERER_STORE_MESSAGE }];
const RENDERER_STORE_PATTERNS = [{ group: ['zustand/*'], message: RENDERER_STORE_MESSAGE }];

// Never lifted: no file, in any area, may reach past a feature's index.ts.
const RENDERER_FEATURE_MESSAGE = 'Import a feature through its index.ts; reaching past it makes every file inside that feature public (ARCH-03).';
const RENDERER_FEATURE_PATTERNS = [
    { regex: '^@renderer/features/[^/]+/.+', message: RENDERER_FEATURE_MESSAGE },
    { regex: '^(\\.\\./)+features/[^/]+/.+', message: RENDERER_FEATURE_MESSAGE }
];

const WEB_STORAGE_MESSAGE = 'v1.2.1 kept the running timer and the goal date in localStorage, which main cannot read and a cleared profile forgets. Anything durable is a row in the database (ARCH-03).';
const WEB_STORAGE_GLOBALS = ['localStorage', 'sessionStorage']
    .map((name) => ({ name, message: WEB_STORAGE_MESSAGE }));
const WEB_STORAGE_PROPERTIES = ['window', 'globalThis', 'self']
    .flatMap((object) => ['localStorage', 'sessionStorage']
        .map((property) => ({ object, property, message: WEB_STORAGE_MESSAGE })));

const BRIDGE_ACCESS_MESSAGE = 'Reach the preload bridge through invoke() or subscribe() in lib/ipc.ts, which is the one place that knows it is there (ARCH-03).';
const BRIDGE_ACCESS_BANS = [
    'MemberExpression[object.name=/^(window|globalThis|self)$/][property.name=\'api\']',
    'MemberExpression[object.name=/^(window|globalThis|self)$/][computed=true][property.value=\'api\']',
    // CR-03(c): Reflect.get is a member expression the parser cannot see as one.
    "CallExpression[callee.object.name='Reflect'][arguments.1.value='api']"
].map((selector) => ({ selector, message: BRIDGE_ACCESS_MESSAGE }));

/*
 * CR-03(c): no-restricted-globals sees the bare name and no-restricted-properties sees window/globalThis/self, so
 * document.defaultView?.localStorage reached a web store with nothing said about it. There is no object in this
 * renderer that legitimately carries a localStorage, so the property name is refused whoever it hangs off.
 */
const WEB_STORAGE_BANS = [
    'MemberExpression[property.name=/^(localStorage|sessionStorage)$/]',
    'MemberExpression[computed=true][property.value=/^(localStorage|sessionStorage)$/]',
    "CallExpression[callee.object.name='Reflect'][arguments.1.value=/^(localStorage|sessionStorage)$/]"
].map((selector) => ({ selector, message: WEB_STORAGE_MESSAGE }));

/*
 * CR-03(a): no-restricted-imports inspects ImportDeclaration and the two export-from forms, and nothing else. It
 * does not inspect ImportExpression, so an await import of @renderer/lib/ipc walked past all four ARCH-03 bans -
 * including the cross-feature one the config marks "never lifted". This is a syntactic rule, so it reaches where
 * no-restricted-imports structurally cannot, and it is composed from the same lift set so an area that lifts a
 * static import lifts the dynamic one with it and nothing else.
 *
 * The selectors use . where a / belongs: esquery parses an attribute regex itself and cannot escape a slash.
 */
const rendererDynamicImports = (lift) => {
    const bans = [];
    if (!lift.has('facade')) {
        bans.push(
            ['ImportExpression[source.value=/lib.ipc$/]', RENDERER_FACADE_MESSAGE],
            ["ImportExpression[source.value='./ipc']", RENDERER_FACADE_MESSAGE],
            ["ImportExpression[source.value='@shared/constants/bridge']", RENDERER_FACADE_MESSAGE]
        );
    }
    if (!lift.has('query')) {
        bans.push(['ImportExpression[source.value=/^@tanstack.react-query/]', RENDERER_QUERY_MESSAGE]);
    }
    if (!lift.has('store')) {
        bans.push(['ImportExpression[source.value=/^zustand/]', RENDERER_STORE_MESSAGE]);
    }
    // Never lifted, as with the static form.
    bans.push(
        ['ImportExpression[source.value=/^@renderer[^a-z0-9_@-]features[^a-z0-9_@-][a-z0-9_-]+[^a-z0-9_@-].+/]', RENDERER_FEATURE_MESSAGE],
        ['ImportExpression[source.value=/^(\\.\\.[^a-z0-9_@-])+features[^a-z0-9_@-][a-z0-9_-]+[^a-z0-9_@-].+/]', RENDERER_FEATURE_MESSAGE]
    );
    return bans.map(([selector, message]) => ({ selector, message }));
};

/** The renderer's syntax bans, composed the way rendererImports composes its paths (D-11). */
const rendererSyntax = (...lifted) => [
    'error', CUSTODY_03, ...DATE_BANS, ...SQL_BANS,
    ...CLASS_BUILD_BANS, ...CLASS_QUERY_BANS, ...BRIDGE_ACCESS_BANS, ...WEB_STORAGE_BANS,
    ...STYLE_INJECTION_BANS, ...rendererDynamicImports(new Set(lifted))
];

/**
 * One composer for every renderer block, so an override restates what it does not lift (D-11) without repeating
 * the list. `lifted` names the bans this area is allowed to break, and nothing else changes.
 */
const rendererImports = (...lifted) => {
    const lift = new Set(lifted);
    const paths = [ZOD_TYPE_ONLY_PATH, ...DRIZZLE_TOOLING_PATHS, ...DRIZZLE_VALUE_PATHS];
    const patterns = [
        ...ZOD_BEARING_SHARED_PATTERNS, ...DRIZZLE_TOOLING_PATTERNS, ...DRIZZLE_VALUE_PATTERNS,
        ...RENDERER_FEATURE_PATTERNS
    ];
    if (!lift.has('facade')) {
        paths.push(...RENDERER_FACADE_PATHS);
        patterns.push(...RENDERER_FACADE_PATTERNS);
    }
    if (!lift.has('query')) {
        paths.push(...RENDERER_QUERY_PATHS);
        patterns.push(...RENDERER_QUERY_PATTERNS);
    }
    if (!lift.has('store')) {
        paths.push(...RENDERER_STORE_PATHS);
        patterns.push(...RENDERER_STORE_PATTERNS);
    }
    return ['error', { paths, patterns }];
};

// The areas ARCH-03 names, each lifting exactly what it is the home of.
const RENDERER_FACADE_FILE = 'src/renderer/src/lib/ipc.ts';
const RENDERER_API_AREAS = ['src/renderer/src/features/*/api/**', 'src/renderer/src/app/providers/**'];
// The client itself and what invalidates it: infrastructure the api hooks and the provider are built out of.
const RENDERER_QUERY_FILES = ['src/renderer/src/lib/query-client.ts', 'src/renderer/src/lib/data-sync.ts'];
const RENDERER_STORE_AREAS = ['src/renderer/src/store/**', 'src/renderer/src/features/*/state/**'];

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
    // EXPIRES IN PHASE 8: the retired v1.2.1 tree, kept until SPA-14 signs off parity and deletes it
    // (tests/lint-coverage.test.ts tripwires it).
    { ignores: ['legacy/**'] },
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
    // The two v1.2.1 files still at the repository root: they hold the SQL this milestone replaces, so they sit
    // outside the SQL bans too. Phase 8 retires them with the rest of the legacy tree.
    {
        files: LEGACY_DATE_EXEMPT,
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
    // ARCH-01's fourth clause: an allowlist, so a new main module that reaches for electron fails instead of
    // quietly becoming a tenth place that knows what Electron is.
    {
        files: ['src/main/**'],
        // services/ is excluded because its own block above bans more than this one does; without this, the weaker
        // rule would be the last match and would replace it.
        ignores: [...MAIN_ELECTRON_ALLOWED, 'src/main/services/**'],
        rules: {
            'no-restricted-imports': ['error', {
                paths: [...MAIN_ELECTRON_PATHS, ...DRIZZLE_TOOLING_PATHS],
                patterns: [...MAIN_ELECTRON_PATTERNS, ...DRIZZLE_TOOLING_PATTERNS]
            }]
        }
    },
    // ARCH-01, criterion 11: the other direction of the same rule - handlers may know the services, never the layer
    // underneath them.
    {
        files: ['src/main/ipc/**'],
        rules: {
            'no-restricted-imports': ['error', {
                paths: [...IPC_LAYER_PATHS, ...DRIZZLE_TOOLING_PATHS],
                patterns: [...IPC_LAYER_PATTERNS, ...DRIZZLE_TOOLING_PATTERNS]
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
            '@typescript-eslint/no-restricted-imports': rendererImports(),
            // Criteria 3 and 7, as lint. Everything src/** already bans is restated, because a flat config replaces
            // a rule's options wholesale (D-11).
            'no-restricted-syntax': rendererSyntax(),
            'no-restricted-globals': ['error', ...WEB_STORAGE_GLOBALS],
            'no-restricted-properties': [
                'error', ...CUSTODY_02, PROCESS_ENV, PROCESS_ARGV, ...WEB_STORAGE_PROPERTIES
            ],
            ...TYPE_IMPORT_RULES
        }
    },
    // The facade itself: the one file that may name the bridge key.
    {
        files: [RENDERER_FACADE_FILE],
        rules: {
            '@typescript-eslint/no-restricted-imports': rendererImports('facade'),
            'no-restricted-syntax': rendererSyntax('facade')
        }
    },
    // Where a call to main and a query may live (ARCH-03).
    {
        files: RENDERER_API_AREAS,
        rules: {
            '@typescript-eslint/no-restricted-imports': rendererImports('facade', 'query'),
            'no-restricted-syntax': rendererSyntax('facade', 'query')
        }
    },
    {
        files: RENDERER_QUERY_FILES,
        rules: {
            '@typescript-eslint/no-restricted-imports': rendererImports('query'),
            'no-restricted-syntax': rendererSyntax('query')
        }
    },
    // Where a Zustand store may live: global UI state, or one feature's own.
    {
        files: RENDERER_STORE_AREAS,
        rules: {
            '@typescript-eslint/no-restricted-imports': rendererImports('store'),
            'no-restricted-syntax': rendererSyntax('store')
        }
    }
];

// D-22/D-23/D-24: one pure, never-throwing config parse pinned to the smoke harness, and an index.ts that is only the
// ordered bootstrap. Plain inputs throughout: neither process nor electron is mocked.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { SHELL_BRIDGE_KEY } from '@shared/constants/bridge';
import {
    DEVELOPMENT_USER_DATA_SUFFIX, MAIN_WINDOW, RENDERER_MARKER_TEXT, SMOKE_DB_ENV, SMOKE_FLAG, USER_DATA_DIR_SWITCH,
    mainConfig, parseMainConfig
} from '../src/main/config';
import {
    DEVELOPMENT_USER_DATA_SUFFIX as USERDATA_SUFFIX, USER_DATA_DIR_SWITCH as USERDATA_SWITCH
} from '../src/main/userdata-path';
import type * as Harness from '../tools/smoke-packaged.mjs';
import { eagerImports, findAll, read, readAliases, repoRoot, resolveSpecifier, scriptKindFor, stripCommentsAndStrings } from './helpers/ts-imports';

const CONFIG = 'src/main/config.ts';
const ENTRY = 'src/main/index.ts';
const HARNESS = 'tools/smoke-packaged.mjs';
const BRIDGE = 'src/shared/constants/bridge.ts';
const MOVED_MODULES = [
    'src/main/window.ts', 'src/main/smoke.ts', 'src/main/lifecycle.ts', 'src/main/legacy-storage.ts',
    'src/main/database-startup.ts'
];
const MAIN_ALIASES = readAliases('electron.vite.config.ts', ['main', 'resolve', 'alias']);
const DATABASE_LAYER = 'src/lib/db';
const DRIVER = 'better-sqlite3';
const DRIZZLE = 'drizzle-orm';

const parse = (file: string, source: string = read(file)): ts.SourceFile =>
    ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.mjs') ? ts.ScriptKind.JS : scriptKindFor(file));

// Every TypeScript file under src/ that git knows, committed or not, so a file added in the same change is covered.
function srcFiles(): string[] {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src'], {
        cwd: repoRoot,
        encoding: 'utf8'
    })
        .split('\n')
        .map((line) => line.trim())
        .filter((file) => /\.tsx?$/.test(file) && fs.existsSync(path.join(repoRoot, file)));
}

function only<T>(items: readonly T[], what: string): T {
    const [item] = items;
    if (items.length !== 1 || item === undefined) {
        throw new Error('expected exactly one ' + what + ', found ' + String(items.length));
    }
    return item;
}

const isImportCall = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;

const callName = (call: ts.CallExpression): string =>
    ts.isIdentifier(call.expression) ? call.expression.text
        : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '(computed)';

const callsIn = (node: ts.Node): string[] =>
    findAll(node, (n): n is ts.CallExpression => ts.isCallExpression(n)).map(callName);

const isDatabaseSpecifier = (fromFile: string, specifier: string): boolean => {
    if (specifier === DRIVER || specifier.startsWith(DRIVER + '/')) {
        return true;
    }
    if (specifier === DRIZZLE || specifier.startsWith(DRIZZLE + '/')) {
        return true;
    }
    const target = resolveSpecifier(fromFile, specifier, MAIN_ALIASES);
    return target !== undefined && (target === DATABASE_LAYER || target.startsWith(DATABASE_LAYER + '/'));
};

const unwrap = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
        ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
        current = current.expression;
    }
    return current;
};

// `process`, or any expression ending in `.process` (globalThis.process).
const isProcess = (node: ts.Expression): boolean => {
    const target = unwrap(node);
    return (ts.isIdentifier(target) && target.text === 'process') ||
        (ts.isPropertyAccessExpression(target) && target.name.text === 'process');
};

const GUARDED = new Set(['env', 'argv']);

/** Each read of process.env / process.argv: property access, element access or object destructuring. */
function processReads(file: string, source: string = read(file)): string[] {
    const sourceFile = parse(file, source);
    const at = (node: ts.Node): string =>
        file + ':' + String(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1) + ' ';
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && GUARDED.has(node.name.text) && isProcess(node.expression)) {
            found.push(at(node) + 'process.' + node.name.text);
        } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) &&
            GUARDED.has(node.argumentExpression.text) && isProcess(node.expression)) {
            found.push(at(node) + 'process[' + JSON.stringify(node.argumentExpression.text) + ']');
        } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
            node.initializer !== undefined && isProcess(node.initializer)) {
            for (const element of node.name.elements) {
                const key = element.propertyName ?? element.name;
                if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && GUARDED.has(key.text)) {
                    found.push(at(node) + '{ ' + key.text + ' } = process');
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}

// Plain Node loads the harness, not vite: .gitattributes checks it out CRLF, and vite's SSR transform (hashbang regex
// /^#!.*\n/, whose `.` cannot match \r) then emits code above the #! line - a SyntaxError at import.
function harnessConstants(): Pick<typeof Harness, 'RENDERER_MARKER_TEXT' | 'SMOKE_DB_ENV'> {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    const script = 'const m = await import(' + JSON.stringify(pathToFileURL(path.join(repoRoot, HARNESS)).href) + ');' +
        'process.stdout.write(JSON.stringify({ RENDERER_MARKER_TEXT: m.RENDERER_MARKER_TEXT, SMOKE_DB_ENV: m.SMOKE_DB_ENV }));';
    const parsed: unknown = JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: repoRoot, env, encoding: 'utf8' })
    );
    if (typeof parsed !== 'object' || parsed === null || !('RENDERER_MARKER_TEXT' in parsed) || !('SMOKE_DB_ENV' in parsed) ||
        typeof parsed.RENDERER_MARKER_TEXT !== 'string' || typeof parsed.SMOKE_DB_ENV !== 'string') {
        throw new Error(HARNESS + ' no longer exports both constants as strings: ' + JSON.stringify(parsed));
    }
    return { RENDERER_MARKER_TEXT: parsed.RENDERER_MARKER_TEXT, SMOKE_DB_ENV: parsed.SMOKE_DB_ENV };
}

const exportedFunctions = (file: string): string[] =>
    parse(file).statements
        .filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s))
        .filter((s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true)
        .map((s) => s.name?.text ?? '(anonymous)');

describe('D-23: parseMainConfig is pure and never throws', () => {
    it('returns a frozen config with every value unset for an empty environment and no arguments', () => {
        const parsed = parseMainConfig({}, []);
        expect(parsed).toEqual({ smoke: false, smokeDbPath: undefined, rendererDevUrl: undefined });
        expect(Object.isFrozen(parsed), 'D-23: the parsed config must be read-only, or a module could rewrite it').toBe(true);
    });

    it('passes a relative smoke database path through untouched, so smoke.ts can report it instead of crashing', () => {
        // A throw here would turn the harness's SMOKE_FAIL report into a startup crash with no SMOKE_ lines.
        const parseRelative = (): ReturnType<typeof parseMainConfig> =>
            parseMainConfig({ WORKFLOW_SMOKE_DB: 'relative.db' }, ['electron', '.', '--smoke']);
        expect(parseRelative, 'D-23: parseMainConfig threw on a bad WORKFLOW_SMOKE_DB; smoke.ts owns that validation').not.toThrow();
        expect(parseRelative()).toEqual({ smoke: true, smokeDbPath: 'relative.db', rendererDevUrl: undefined });
    });

    it('treats an empty ELECTRON_RENDERER_URL as unset and returns a set one as given', () => {
        expect(parseMainConfig({ ELECTRON_RENDERER_URL: '' }, []).rendererDevUrl).toBeUndefined();
        expect(parseMainConfig({ ELECTRON_RENDERER_URL: 'http://localhost:5173/' }, []).rendererDevUrl)
            .toBe('http://localhost:5173/');
    });

    it('recognises --smoke only as the exact argument', () => {
        expect(parseMainConfig({}, ['--smoked']).smoke, 'D-23: a look-alike argument started a smoke launch').toBe(false);
        expect(parseMainConfig({}, ['app.exe', '--smoke']).smoke).toBe(true);
    });

    it('exports the module-level config and the window geometry frozen', () => {
        expect(Object.isFrozen(mainConfig)).toBe(true);
        expect(Object.isFrozen(MAIN_WINDOW)).toBe(true);
    });
});

describe('D-24: the values the smoke harness depends on equal its own', () => {
    it('shares the renderer marker and the smoke database variable with ' + HARNESS, () => {
        const harness = harnessConstants();
        expect(RENDERER_MARKER_TEXT, 'D-24: ' + CONFIG + ' and ' + HARNESS + ' disagree on the marker, so the packaged ' +
            'smoke launch would wait for text the harness never checks').toBe(harness.RENDERER_MARKER_TEXT);
        expect(SMOKE_DB_ENV, 'D-24: the app would read a different variable than the one the harness injects')
            .toBe(harness.SMOKE_DB_ENV);
    });

    it('uses as SMOKE_FLAG the first argument the harness spawns the packaged binary with', () => {
        const spawn = only(
            findAll(parse(HARNESS), (n): n is ts.CallExpression =>
                ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'spawn'),
            'spawn(...) call in ' + HARNESS
        );
        const args = spawn.arguments[1];
        if (args === undefined || !ts.isArrayLiteralExpression(args)) {
            throw new Error(HARNESS + ': spawn\'s second argument is no longer an array literal; teach this test its shape');
        }
        const first = args.elements[0];
        if (first === undefined || !ts.isStringLiteralLike(first)) {
            throw new Error(HARNESS + ': spawn\'s first argument is no longer a string literal; teach this test its shape');
        }
        expect(SMOKE_FLAG, 'D-24: the packaged app would not recognise the flag the harness launches it with, ' +
            'so it would open a normal window instead of reporting').toBe(first.text);
    });
});

describe('IN-01: the preload bridge key has one source', () => {
    it('is declared only in ' + BRIDGE + ', and resolves through the @shared alias', () => {
        expect(typeof SHELL_BRIDGE_KEY, 'the @shared alias did not resolve').toBe('string');
        expect(SHELL_BRIDGE_KEY.length, 'the @shared alias resolved to an empty key').toBeGreaterThan(0);
        const files = srcFiles();
        expect(files, 'the scan cannot see the files it guards').toEqual(expect.arrayContaining([BRIDGE, 'src/preload/index.ts', ENTRY]));
        const holders = files.filter((file) =>
            stripCommentsAndStrings(file, read(file)).strings.some((s) => s.value === SHELL_BRIDGE_KEY));
        expect(holders, 'IN-01: the bridge key is spelled again outside ' + BRIDGE + '; two copies drift and the smoke ' +
            'launch would read a key the preload no longer exposes').toEqual([BRIDGE]);
    });
});

describe('D-23: userdata-path re-exports the values config.ts owns', () => {
    it('hands out the same suffix and switch as ' + CONFIG, () => {
        expect(USERDATA_SUFFIX).toBe(DEVELOPMENT_USER_DATA_SUFFIX);
        expect(USERDATA_SWITCH).toBe(USER_DATA_DIR_SWITCH);
    });
});

describe('D-23 / SC6: no module reads process.env or process.argv except ' + CONFIG, () => {
    it('the detector finds every read form it guards, and finds config.ts\'s own two reads', () => {
        const sample = [
            'const a = process.env.PATH;',
            "const b = process['argv'];",
            'const { env } = process;',
            'const { argv: args } = globalThis.process;',
            'const c = (process as NodeJS.Process).env;',
            'const d = process.platform;',
            'const e = other.env;'
        ].join('\n');
        expect(processReads('src/main/sample.ts', sample)).toEqual([
            'src/main/sample.ts:1 process.env',
            'src/main/sample.ts:2 process["argv"]',
            'src/main/sample.ts:3 { env } = process',
            'src/main/sample.ts:4 { argv } = process',
            'src/main/sample.ts:5 process.env'
        ]);
        expect(processReads(CONFIG).map((r) => r.slice(r.indexOf(' ') + 1)), 'the positive control no longer holds')
            .toEqual(['process.env', 'process.argv']);
    });

    it('finds no read in any other git-known src/**/*.ts or *.tsx file', () => {
        const files = srcFiles().filter((file) => file !== CONFIG);
        expect(files, 'the scan cannot see the main-process modules').toEqual(expect.arrayContaining([ENTRY, ...MOVED_MODULES]));
        expect(files.flatMap((file) => processReads(file)), 'SC6/D-23: these modules bypass ' + CONFIG + '; parse the value ' +
            'there once, so a malformed environment is handled in one place and never at a call site').toEqual([]);
    });

    it(CONFIG + ' imports nothing, so loading it ahead of the lock can load nothing', () => {
        const sourceFile = parse(CONFIG);
        const imports = sourceFile.statements.filter((s) =>
            ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s) ||
            (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined));
        expect(imports.map((s) => s.getText(sourceFile)), 'D-23: ' + CONFIG + ' gained an import').toEqual([]);
        expect(findAll(sourceFile, isImportCall).length, 'D-23: ' + CONFIG + ' gained an import() call').toBe(0);
    });
});

describe('D-22: ' + ENTRY + ' is the ordered bootstrap and nothing else', () => {
    const sourceFile = parse(ENTRY);
    const statements = [...sourceFile.statements];
    const firstCode = statements.findIndex((s) => !ts.isImportDeclaration(s));
    const body = firstCode < 0 ? [] : statements.slice(firstCode);
    const shape = (s: ts.Statement): string => {
        if (ts.isImportDeclaration(s)) return 'import';
        if (ts.isIfStatement(s)) return 'if';
        if (ts.isVariableStatement(s)) return 'const';
        if (ts.isFunctionDeclaration(s)) {
            const isAsync = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
            return (isAsync ? 'async ' : '') + 'function ' + (s.name?.text ?? '(anonymous)');
        }
        return 'other: ' + (s.getText(sourceFile).split('\n')[0] ?? '');
    };

    it('is imports, the userData policy, the lock, the lock branch and async main - in that order', () => {
        expect(firstCode, ENTRY + ' does not start with its imports').toBeGreaterThan(0);
        expect(body.map(shape), 'D-22: ' + ENTRY + ' holds more than the ordered bootstrap; move the rest to its own ' +
            'module, because every statement here runs in the window where the lock order is decided')
            .toEqual(['if', 'const', 'if', 'async function main']);
        const [userDataPolicy, lock, lockBranch] = body;
        if (userDataPolicy === undefined || lock === undefined || lockBranch === undefined || !ts.isIfStatement(lockBranch)) {
            throw new Error('unreachable once the shape above matched');
        }
        expect(callsIn(userDataPolicy), 'D-22: the pre-lock if may only apply the userData policy')
            .toEqual(['applyUnpackagedUserDataPath']);
        expect(callsIn(lock), 'D-22: the lock statement may only take the lock').toEqual(['requestSingleInstanceLock']);
        expect(findAll(lockBranch.expression, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === 'holdsInstanceLock'))
            .toHaveLength(1);
    });

    it('constructs no window, and imports the database layer once, inside main, after awaiting whenReady', () => {
        expect(findAll(sourceFile, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === 'BrowserWindow'),
            'D-22: window code is back in ' + ENTRY).toEqual([]);
        expect(findAll(sourceFile, (n): n is ts.NewExpression => ts.isNewExpression(n)), 'D-22: ' + ENTRY + ' constructs something')
            .toEqual([]);
        const main = only(
            statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'main'),
            'function main in ' + ENTRY
        );
        const importCall = only(findAll(sourceFile, isImportCall), 'import() call in ' + ENTRY);
        expect(importCall.pos >= main.pos && importCall.end <= main.end, 'D-22: the database import left main()').toBe(true);
        const specifier = importCall.arguments[0];
        expect(specifier !== undefined && ts.isStringLiteral(specifier) && isDatabaseSpecifier(ENTRY, specifier.text),
            'the one import() no longer names the database layer by a literal specifier').toBe(true);
        const ready = only(
            findAll(main, (n): n is ts.AwaitExpression =>
                ts.isAwaitExpression(n) && ts.isCallExpression(n.expression) && callName(n.expression) === 'whenReady'),
            'await of app.whenReady() in main'
        );
        expect(ready.getStart(sourceFile) < importCall.getStart(sourceFile),
            'D-22: the database layer is imported before app.whenReady resolves').toBe(true);
    });
});

describe('D-22: the moved main modules own their concerns without loading the database layer', () => {
    const OWNERSHIP: [string, string[]][] = [
        ['src/main/window.ts', ['createMainWindow', 'hardenWebContents', 'mainWindows', 'hasCreatedMainWindow']],
        ['src/main/lifecycle.ts', [
            'registerLifecycle', 'openMainWindow', 'launchApplication', 'registerDatabaseCloser', 'closeDatabaseNow',
            'shouldQuitOnAllClosed'
        ]],
        ['src/main/smoke.ts', ['runSmoke', 'finishSmoke']],
        ['src/main/legacy-storage.ts', ['readLegacyStorage']],
        ['src/main/database-startup.ts', ['startDatabase', 'refusalMessage', 'doorMessage', 'failureMessage']]
    ];

    it.each(OWNERSHIP)('%s exports %j', (file, names) => {
        expect(exportedFunctions(file), 'D-22: ' + file + ' no longer owns its concern').toEqual(expect.arrayContaining(names));
    });

    it('none of them calls import() or eagerly imports the database layer', () => {
        expect(MAIN_ALIASES.size, 'the main aliases did not resolve, so an aliased import could slip through').toBeGreaterThan(0);
        for (const file of MOVED_MODULES) {
            const sourceFile = parse(file);
            expect(findAll(sourceFile, isImportCall).map((n) => n.getText(sourceFile)),
                file + ' calls import(); only ' + ENTRY + ' may, after the lock').toEqual([]);
            expect(eagerImports(sourceFile, true).filter((i) => isDatabaseSpecifier(file, i.specifier)).map((i) => i.specifier),
                file + ' loads the database layer when it is loaded, which is before the lock').toEqual([]);
        }
    });

    it('smoke.ts names the database layer only through a type-only import', () => {
        const file = 'src/main/smoke.ts';
        const sourceFile = parse(file);
        const databaseImports = sourceFile.statements.filter((s): s is ts.ImportDeclaration =>
            ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && isDatabaseSpecifier(file, s.moduleSpecifier.text));
        expect(databaseImports.length, file + ' no longer types its injected opener from the client module').toBeGreaterThan(0);
        expect(databaseImports.every((s) => s.importClause?.isTypeOnly === true),
            file + ' value-imports the database layer, which would load it before the lock').toBe(true);
    });
});

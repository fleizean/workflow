// BUILD-03 / D-15 and BUILD-04: the single-instance lock is taken before anything loads the database layer, and
// loading the database client opens nothing. Two processes on one krono.db is how v1.2.1 corrupts it.

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
    eagerImports, findAll, read, readAliases, resolveModuleFile, resolveSpecifier, runsAtModuleLoad, scriptKindFor,
    stripCommentsAndStrings
} from './helpers/ts-imports';

const ENTRY = 'src/main/index.ts';
const CLIENT = 'src/lib/db/client.ts';

// Everything under src/lib/db opens or copies SQLite files; better-sqlite3 is the driver itself.
const DATABASE_LAYER_DIR = 'src/lib/db';
const DRIVER = 'better-sqlite3';

const TWO_PROCESSES =
    'A second copy of the app launched alongside the first would load the database layer before ' +
    'discovering it must quit - two processes on one SQLite file, which is how v1.2.1 corrupts ' +
    'krono.db (main.js line 6 -> database/db.js line 10). The single-instance lock must come first ' +
    '(BUILD-03, D-15).';

const VITE_CONFIG = 'electron.vite.config.ts';
const MAIN_ALIASES = readAliases(VITE_CONFIG, ['main', 'resolve', 'alias']);

/*
 * Whether `specifier`, written in `fromFile`, names the database layer or its driver.
 *
 * A string containing whitespace is prose, never a module specifier, and is rejected before any
 * matching - otherwise the path-alias fallback below finds a path fragment inside a sentence (the
 * first version of this function did exactly that, and the negative-control mutation caught it).
 */
function isDatabaseSpecifier(fromFile: string, specifier: string): boolean {
    if (specifier === '' || /\s/.test(specifier)) {
        return false;
    }
    if (specifier === DRIVER || specifier.startsWith(DRIVER + '/')) {
        return true;
    }
    const target = resolveSpecifier(fromFile, specifier, MAIN_ALIASES);
    if (target !== undefined) {
        return target === DATABASE_LAYER_DIR || target.startsWith(DATABASE_LAYER_DIR + '/');
    }
    // An alias the build config does not define: match the tail, counting `@` as a boundary (WR-02).
    return /(^|[/@])lib\/db(\/|$)/.test(specifier);
}

/*
 * Every chain of eager imports, starting at `entry` and following relative specifiers through the
 * repository, that ends at the database layer. Packages other than the driver are not followed:
 * electron and node builtins are not ours to walk, and the driver is caught by name.
 */
function eagerChainsToDatabase(entry: string): string[] {
    const chains: string[] = [];
    const seen = new Set<string>();
    const walk = (file: string, trail: string[]): void => {
        if (seen.has(file)) {
            return;
        }
        seen.add(file);
        const sourceFile = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, scriptKindFor(file));
        for (const { specifier } of eagerImports(sourceFile, file !== entry)) {
            const step = [...trail, file + " imports '" + specifier + "'"];
            if (isDatabaseSpecifier(file, specifier)) {
                chains.push(step.join(' -> '));
            } else {
                const next = resolveModuleFile(file, specifier, MAIN_ALIASES);
                if (next !== undefined) {
                    walk(next, step);
                }
            }
        }
    };
    walk(entry, []);
    return chains;
}

const isLockCall = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'requestSingleInstanceLock';

const LOCK_CALL = /\.\s*requestSingleInstanceLock\s*\(/;

// The only module whose functions may run before the lock: the development userData policy.
const PRE_LOCK_MODULE = 'src/main/userdata-path';

// WR-02: text order is not execution order - a hoisted function called above the lock runs first.
// So above the lock only declarations may appear, and the only calls allowed go into PRE_LOCK_MODULE.
function preLockViolations(fileName: string, sourceFile: ts.SourceFile): string[] {
    const lockIndex = sourceFile.statements.findIndex((statement) =>
        findAll(statement, isLockCall).some((call) => runsAtModuleLoad(call)));
    if (lockIndex < 0) {
        return ['no top-level requestSingleInstanceLock call'];
    }
    const allowed = new Set<string>();
    for (const statement of sourceFile.statements) {
        const bindings = ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
            resolveSpecifier(fileName, statement.moduleSpecifier.text, MAIN_ALIASES) === PRE_LOCK_MODULE
            ? statement.importClause?.namedBindings
            : undefined;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
            bindings.elements.forEach((element) => allowed.add(element.name.text));
        }
    }

    const violations: string[] = [];
    const at = (node: ts.Node): string => 'line ' +
        String(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1) + ': ' +
        (node.getText(sourceFile).split('\n')[0] ?? '');
    const inspect = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) {
            return; // a body runs only when called, and the call is what this looks for
        }
        if (ts.isCallExpression(node)) {
            if (!(ts.isIdentifier(node.expression) && allowed.has(node.expression.text))) {
                violations.push('calls ' + at(node));
            }
        } else if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isAwaitExpression(node)) {
            violations.push('evaluates ' + at(node));
        }
        ts.forEachChild(node, inspect);
    };
    for (const statement of sourceFile.statements.slice(0, lockIndex)) {
        if (ts.isImportDeclaration(statement) || ts.isFunctionDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
            continue;
        }
        if (ts.isVariableStatement(statement) || ts.isIfStatement(statement) || ts.isExpressionStatement(statement)) {
            inspect(statement);
        } else {
            violations.push('cannot prove inert ' + at(statement));
        }
    }
    return violations;
}

describe('the analysis itself: comments and strings never reach the analysed text', () => {
    it('blanks line, block and JSDoc comments, strings, templates and regex literals, keeping offsets', () => {
        const sample = [
            '/** requestSingleInstanceLock() in JSDoc */',
            '// requestSingleInstanceLock() in a line comment',
            '/* \'../lib/db/client\' in a block comment */',
            'const a = "requestSingleInstanceLock()";',
            'const b = `x ${a} requestSingleInstanceLock()`;',
            'const c = /requestSingleInstanceLock\\(/;',
            'app.requestSingleInstanceLock();',
            'void import(\'../lib/db/client\');'
        ].join('\n');
        const { code, strings } = stripCommentsAndStrings('sample.ts', sample);

        expect(code).toHaveLength(sample.length);
        expect(code.match(/requestSingleInstanceLock/g), 'only the real call may survive').toHaveLength(1);
        expect(code.indexOf('app.requestSingleInstanceLock();')).toBe(sample.indexOf('app.requestSingleInstanceLock();'));
        expect(code.includes('lib/db/client'), 'no specifier or comment text may survive as code').toBe(false);
        expect(code.includes('${a}'), 'template text is blanked').toBe(false);
        // The `${` and `}` belong to the template's own head and tail tokens and are blanked with
        // them; the expression between them is code and survives at its original offset.
        expect(code.charAt(sample.indexOf('${a}') + 2), 'code inside a template substitution is kept').toBe('a');
        expect(strings.map((s) => s.value)).toEqual(['requestSingleInstanceLock()', '../lib/db/client']);
        // The real import() on the last line - not the identical text inside the block comment,
        // which comes first in the source and must never be reported.
        expect(strings[1]?.start).toBe(sample.lastIndexOf('\'../lib/db/client\''));
    });

    it('counts a string as a database reference only when its whole value is a module specifier', () => {
        // Module references, in each form the entry could use.
        expect(isDatabaseSpecifier(ENTRY, '../lib/db/client')).toBe(true);
        expect(isDatabaseSpecifier(ENTRY, '../lib/db/backup')).toBe(true);
        expect(isDatabaseSpecifier(ENTRY, '../lib/db')).toBe(true);
        expect(isDatabaseSpecifier(ENTRY, DRIVER)).toBe(true);
        expect(isDatabaseSpecifier(ENTRY, '@/lib/db/client')).toBe(true);
        // WR-02: the alias electron.vite.config.ts actually defines for the main target.
        expect(isDatabaseSpecifier(ENTRY, '@lib/db/client')).toBe(true);
        expect(isDatabaseSpecifier(ENTRY, '@lib/db')).toBe(true);
        // Prose that merely mentions them, and modules that are not the database layer.
        expect(isDatabaseSpecifier(ENTRY, 'the lock precedes ../lib/db/client')).toBe(false);
        expect(isDatabaseSpecifier(ENTRY, 'better-sqlite3 is loaded later')).toBe(false);
        expect(isDatabaseSpecifier(ENTRY, './userdata-path')).toBe(false);
        expect(isDatabaseSpecifier(ENTRY, '@main/userdata-path')).toBe(false);
        expect(isDatabaseSpecifier(ENTRY, 'electron')).toBe(false);
    });

    it('resolves the main target aliases from the build config itself (WR-02)', () => {
        expect(MAIN_ALIASES.size, VITE_CONFIG + ' defines main aliases, but the reader found none').toBeGreaterThan(0);
        expect(resolveSpecifier(ENTRY, '@lib/db/client', MAIN_ALIASES), 'the @lib alias no longer resolves through ' + VITE_CONFIG)
            .toBe('src/lib/db/client');
    });

    it('flags code that runs above the lock, wherever that code is written (WR-02)', () => {
        const parse = (lines: string[]): ts.SourceFile =>
            ts.createSourceFile(ENTRY, lines.join('\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const head = [
            "import { app } from 'electron';",
            "import { applyDevelopmentUserDataPath } from './userdata-path';",
            "const FLAG = '--smoke';",
            'if (!app.isPackaged) { applyDevelopmentUserDataPath(app); }'
        ];
        const lock = 'const holdsInstanceLock = app.requestSingleInstanceLock();';
        const warmUp = "async function warmUp() { await import('../lib/db/client'); }";

        expect(preLockViolations(ENTRY, parse([...head, lock, 'void warmUp();', warmUp]))).toEqual([]);
        // The bypass the review found: the hoisted function is written after the lock, called before it.
        expect(preLockViolations(ENTRY, parse([...head, 'void warmUp();', lock, warmUp])))
            .toEqual(['calls line 5: warmUp()']);
        expect(preLockViolations(ENTRY, parse([...head, 'const ready = app.whenReady();', lock])))
            .toEqual(['calls line 5: app.whenReady()']);
        expect(preLockViolations(ENTRY, parse([...head, 'if (!app.isPackaged) { applyDevelopmentUserDataPath(warmUp()); }', lock, warmUp])))
            .toEqual(['calls line 5: warmUp()']);
        expect(preLockViolations(ENTRY, parse(head))).toEqual(['no top-level requestSingleInstanceLock call']);
    });
});

describe('BUILD-03 / D-15: the single-instance lock is acquired before the database layer loads', () => {
    const source = read(ENTRY);
    const { code, strings, sourceFile } = stripCommentsAndStrings(ENTRY, source);
    const lockIndex = code.search(LOCK_CALL);
    const firstDatabaseReference = strings.find((s) => isDatabaseSpecifier(ENTRY, s.value));

    it('finds the lock call and the first database-layer reference in ' + ENTRY, () => {
        expect(lockIndex, ENTRY + ' no longer calls requestSingleInstanceLock outside a comment or string')
            .toBeGreaterThanOrEqual(0);
        expect(
            firstDatabaseReference,
            ENTRY + ' no longer names the database layer by a literal module specifier, so the ' +
            'ordering cannot be checked. Reach it through a literal import(), after the lock.'
        ).toBeDefined();
    });

    it('acquires the lock before the first reference to the database layer', () => {
        expect(firstDatabaseReference).toBeDefined();
        const referenceIndex = firstDatabaseReference?.start ?? -1;
        expect(
            lockIndex >= 0 && lockIndex < referenceIndex,
            ENTRY + ': the lock (offset ' + String(lockIndex) + ') does not come before \'' +
            String(firstDatabaseReference?.value) + '\' (offset ' + String(referenceIndex) + '). ' +
            TWO_PROCESSES
        ).toBe(true);
    });

    it('acquires the lock at module top level, where source order is execution order', () => {
        // Inside a function the call would run whenever that function runs, and its position in
        // the text would say nothing about when that is.
        const calls = findAll(sourceFile, isLockCall);
        expect(calls.length, ENTRY + ' has no requestSingleInstanceLock call').toBeGreaterThan(0);
        const nested = calls.filter((call) => !runsAtModuleLoad(call));
        expect(
            nested.map((call) => 'line ' + String(sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1)),
            ENTRY + ' acquires the lock inside a function. ' + TWO_PROCESSES
        ).toEqual([]);
    });

    it('does not load the database layer eagerly, directly or through any module it imports', () => {
        // An eager import is evaluated before the first line of the importing module's body,
        // whatever the source order suggests - the exact defect at main.js line 6.
        const direct = eagerImports(sourceFile).filter((i) => isDatabaseSpecifier(ENTRY, i.specifier));
        expect(
            direct.map((i) => i.specifier),
            ENTRY + ' imports the database layer statically, so it loads before the lock. ' + TWO_PROCESSES
        ).toEqual([]);
        expect(eagerChainsToDatabase(ENTRY), 'eager import chains reaching the database layer. ' + TWO_PROCESSES)
            .toEqual([]);
    });

    it('executes nothing above the lock except calls into ' + PRE_LOCK_MODULE + ' (WR-02)', () => {
        expect(
            preLockViolations(ENTRY, sourceFile),
            ENTRY + ': code above the lock runs before it, wherever the code it calls is written. ' + TWO_PROCESSES
        ).toEqual([]);
    });

    it('keeps ' + PRE_LOCK_MODULE + ', whose functions run before the lock, clear of the database layer (WR-02)', () => {
        const file = PRE_LOCK_MODULE + '.ts';
        const { strings } = stripCommentsAndStrings(file, read(file));
        expect(
            strings.filter((s) => isDatabaseSpecifier(file, s.value)).map((s) => s.value),
            file + ' names the database layer, and it runs before the lock. ' + TWO_PROCESSES
        ).toEqual([]);
    });
});

describe('BUILD-04: the database client opens nothing when it is loaded', () => {
    const { sourceFile } = stripCommentsAndStrings(CLIENT, read(CLIENT));

    // Local names bound to the driver's runtime exports (type-only imports are erased).
    const driverBindings = new Set<string>();
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== DRIVER || statement.importClause === undefined ||
            statement.importClause.isTypeOnly) {
            continue;
        }
        const clause = statement.importClause;
        if (clause.name !== undefined) {
            driverBindings.add(clause.name.text);
        }
        if (clause.namedBindings !== undefined) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
                driverBindings.add(clause.namedBindings.name.text);
            } else {
                for (const element of clause.namedBindings.elements) {
                    driverBindings.add(element.name.text);
                }
            }
        }
    }

    // `new Database(...)` and the driver's call-without-new form, plus the module's own opener.
    const openers = new Set([...driverBindings, 'openDatabase']);
    const constructions = findAll(sourceFile, (node): node is ts.NewExpression | ts.CallExpression =>
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        ts.isIdentifier(node.expression) && openers.has(node.expression.text));

    it('imports the driver, and constructs a handle somewhere (so the next check is not vacuous)', () => {
        expect([...driverBindings], CLIENT + ' no longer imports ' + DRIVER + ' by a runtime binding')
            .not.toEqual([]);
        expect(constructions.length, CLIENT + ' constructs no database handle at all').toBeGreaterThan(0);
    });

    it('constructs every database handle inside a function body, never at module scope', () => {
        const atLoad = constructions
            .filter((node) => runsAtModuleLoad(node))
            .map((node) => 'line ' + String(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1) +
                ': ' + node.getText(sourceFile));
        expect(
            atLoad,
            CLIENT + ' opens a database while it is being loaded - database/db.js line 10\'s defect. ' +
            'Importing the client must have no side effect, or even a correctly ordered import ' +
            'opens krono.db before the lock. ' + TWO_PROCESSES
        ).toEqual([]);
    });
});

/*
 * tests/lock-ordering.test.ts
 *
 * The standing proof for BUILD-03 (D-15) and BUILD-04: the single-instance lock is acquired
 * before any database-touching module is loaded, and the database client opens nothing when it is
 * loaded.
 *
 * The failure this prevents is two processes on one SQLite file. v1.2.1 has it today: main.js
 * requires database/db.js on its sixth line, that module opens krono.db at module load (db.js line
 * 10), and a top-level require runs before any lifecycle hook - so a second copy of the app,
 * launched while the first is running, has already opened the user's database before it can find
 * out that it is the second copy and must quit. Two writers on one file is how a SQLite database
 * holding every session a user ever tracked gets corrupted, on a machine the owner cannot reach.
 *
 * WHY THIS IS A STRUCTURAL TEST OVER SOURCE TEXT, NOT A RUNTIME TEST. The main process cannot be
 * imported outside Electron. And D-15 is explicit that the failure is an ORDERING failure, which
 * is invisible to a search for the lock call on its own: the call can be present, correct, and
 * still run after the database has opened. So this file computes two positions and compares them.
 *
 * WHY COMMENTS AND STRING LITERALS ARE REMOVED FIRST. A textual gate in this repository has
 * already matched prose (plan 01-08's module-shape gate matched a comment describing a path
 * accessor), and src/main/index.ts deliberately carries a header explaining why its import order
 * is the contract - a header that, if it named the client module by path, would sit textually
 * ahead of the lock. The removal uses the TypeScript parser rather than a regular expression:
 * comments are trivia and never tokens, and string, template and regular-expression literals are
 * token kinds of their own, so nothing a person writes in prose can land in the analysed text.
 * String literals are removed from that text, and the only strings the test reads back are those
 * whose ENTIRE value is a database-layer module specifier - a module reference, not prose.
 *
 * Each assertion was turned red by a deliberate mutation of src/main/index.ts or
 * src/lib/db/client.ts before this file was committed, and the file restored byte-identically
 * (plan 02-02's SUMMARY records the hashes).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

interface StringToken {
    value: string;
    start: number;
}

interface StrippedSource {
    /** The source with every comment and every string-like literal blanked; offsets unchanged. */
    code: string;
    /** Plain string literals, with their values and offsets, recovered from the parser. */
    strings: StringToken[];
    sourceFile: ts.SourceFile;
}

const STRING_LIKE = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.RegularExpressionLiteral
]);

const isJsDoc = (node: ts.Node): boolean =>
    node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

/*
 * Removes comments and string literals from TypeScript source, keeping every offset.
 *
 * The output starts as all blanks (line breaks kept, so offsets and line numbers survive) and only
 * the characters of real code tokens are copied back. Comments are never tokens, so they stay
 * blank. JSDoc blocks are attached to the tree as nodes and are skipped explicitly. String-like
 * literals are tokens, but their characters are not copied: their values are handed back
 * separately, so a caller can look for module specifiers without prose inside a string ever
 * appearing as code.
 */
export function stripCommentsAndStrings(fileName: string, source: string): StrippedSource {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out: string[] = source.split('').map((ch) => (ch === '\n' || ch === '\r' ? ch : ' '));
    const strings: StringToken[] = [];

    const visit = (node: ts.Node): void => {
        if (isJsDoc(node)) {
            return;
        }
        const children = node.getChildren(sourceFile);
        if (children.length > 0) {
            children.forEach(visit);
            return;
        }
        const start = node.getStart(sourceFile);
        if (STRING_LIKE.has(node.kind)) {
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                strings.push({ value: node.text, start });
            }
            return;
        }
        for (let i = start; i < node.getEnd(); i++) {
            out[i] = source.charAt(i);
        }
    };
    visit(sourceFile);

    return { code: out.join(''), strings, sourceFile };
}

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
    if (specifier.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
        return target === DATABASE_LAYER_DIR || target.startsWith(DATABASE_LAYER_DIR + '/');
    }
    // A path alias would bypass the relative resolution above; match its tail instead.
    return /(^|\/)lib\/db(\/|$)/.test(specifier);
}

/** Whether `node` executes while its module is being loaded, rather than when a function runs. */
function runsAtModuleLoad(node: ts.Node): boolean {
    for (let p = node.parent; p !== undefined; p = p.parent) {
        if (ts.isFunctionLike(p)) {
            return false;
        }
        // An instance field initialiser runs at construction, not at module load.
        if (ts.isPropertyDeclaration(p) &&
            !(ts.getCombinedModifierFlags(p) & ts.ModifierFlags.Static)) {
            return false;
        }
    }
    return true;
}

interface RuntimeImport {
    specifier: string;
    start: number;
}

/*
 * The module specifiers a file loads, eagerly, while it is itself being loaded: static imports
 * that are not type-only, re-exports, `import x = require()`, and module-scope require() calls.
 * A dynamic import() is not eager and is deliberately not listed - that is the sanctioned way to
 * reach the database layer after the lock.
 */
function eagerImports(sourceFile: ts.SourceFile): RuntimeImport[] {
    const found: RuntimeImport[] = [];
    const add = (literal: ts.Expression | undefined): void => {
        if (literal !== undefined && ts.isStringLiteral(literal)) {
            found.push({ specifier: literal.text, start: literal.getStart(sourceFile) });
        }
    };
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            if (statement.importClause?.isTypeOnly !== true) {
                add(statement.moduleSpecifier);
            }
        } else if (ts.isExportDeclaration(statement)) {
            if (!statement.isTypeOnly) {
                add(statement.moduleSpecifier);
            }
        } else if (ts.isImportEqualsDeclaration(statement) &&
            ts.isExternalModuleReference(statement.moduleReference)) {
            add(statement.moduleReference.expression);
        }
    }
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
            node.expression.text === 'require' && runsAtModuleLoad(node)) {
            add(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '/index.ts'];

/** Resolves a relative specifier to a repository file, or undefined if none exists. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    for (const candidate of [base, ...RESOLVE_EXTENSIONS.map((ext) => base + ext)]) {
        const abs = path.join(repoRoot, candidate);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            return candidate;
        }
    }
    return undefined;
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
        const sourceFile = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        for (const { specifier } of eagerImports(sourceFile)) {
            const step = [...trail, file + " imports '" + specifier + "'"];
            if (isDatabaseSpecifier(file, specifier)) {
                chains.push(step.join(' -> '));
            } else if (specifier.startsWith('.')) {
                const next = resolveRelative(file, specifier);
                if (next !== undefined) {
                    walk(next, step);
                }
            }
        }
    };
    walk(entry, []);
    return chains;
}

/** Nodes of `sourceFile` matching `predicate`, in source order. */
function findAll<T extends ts.Node>(sourceFile: ts.SourceFile, predicate: (n: ts.Node) => n is T): T[] {
    const found: T[] = [];
    const visit = (node: ts.Node): void => {
        if (predicate(node)) {
            found.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}

const isLockCall = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'requestSingleInstanceLock';

const LOCK_CALL = /\.\s*requestSingleInstanceLock\s*\(/;

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
        // Prose that merely mentions them, and modules that are not the database layer.
        expect(isDatabaseSpecifier(ENTRY, 'the lock precedes ../lib/db/client')).toBe(false);
        expect(isDatabaseSpecifier(ENTRY, 'better-sqlite3 is loaded later')).toBe(false);
        expect(isDatabaseSpecifier(ENTRY, './userdata-path')).toBe(false);
        expect(isDatabaseSpecifier(ENTRY, 'electron')).toBe(false);
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

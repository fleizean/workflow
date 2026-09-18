// TypeScript-AST helpers shared by the structural gates. Not a .test.ts file, so vitest never collects it and
// importing it registers no suites.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function read(rel: string): string {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

export function scriptKindFor(file: string): ts.ScriptKind {
    return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

export interface StringToken {
    value: string;
    start: number;
}

export interface StrippedSource {
    /** The source with every comment and every string-like literal blanked; offsets unchanged. */
    code: string;
    /** Plain string literals, with their values and offsets, recovered from the parser. */
    strings: StringToken[];
    sourceFile: ts.SourceFile;
}

export interface RuntimeImport {
    specifier: string;
    start: number;
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

// Only real code tokens are copied back, so comments stay blank. String-like literals are blanked too; plain string
// values come back separately, so a caller can find module specifiers without prose ever reading as code.
export function stripCommentsAndStrings(fileName: string, source: string): StrippedSource {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
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

/** Nodes under `root` (itself included) matching `predicate`, in source order. */
export function findAll<T extends ts.Node>(root: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
    const found: T[] = [];
    const visit = (node: ts.Node): void => {
        if (predicate(node)) {
            found.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
}

/** Whether `node` executes while its module is being loaded, rather than when a function runs. */
export function runsAtModuleLoad(node: ts.Node): boolean {
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

// Specifiers a file loads while it is itself loading: value imports and re-exports, `import x = require()` and
// module-scope require(). A dynamic import() is the sanctioned lazy path and is listed only on request.
export function eagerImports(sourceFile: ts.SourceFile, includeLoadTimeImportCalls = false): RuntimeImport[] {
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
        // WR-02: an import() at load time in a module the entry imports runs before the entry's lock.
        const isRequire = ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
            node.expression.text === 'require';
        const isImportCall = includeLoadTimeImportCalls && ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if ((isRequire || isImportCall) && runsAtModuleLoad(node)) {
            add(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}

const propertyNameText = (name: ts.PropertyName | undefined): string | undefined =>
    name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;

interface AliasBlock {
    sourceFile: ts.SourceFile;
    properties: readonly ts.ObjectLiteralElementLike[];
    unreadable: (what: string) => Error;
}

// WR-02: gates read aliases from the build config itself, so they resolve what the build resolves. A shape this
// reader does not know fails loudly instead of silently resolving nothing.
function aliasBlock(configFile: string, objectPath: readonly string[], reader: string): AliasBlock {
    const sourceFile = ts.createSourceFile(configFile, read(configFile), ts.ScriptTarget.Latest, true, scriptKindFor(configFile));
    const unreadable = (what: string): Error =>
        new Error(configFile + ': ' + what + '; teach ' + reader + ' in tests/helpers/ts-imports.ts this shape');
    const objectAt = (object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression | undefined => {
        if (object.properties.some(ts.isSpreadAssignment)) {
            throw unreadable('a spread sits beside `' + name + '`');
        }
        const property = object.properties.find((p) => propertyNameText(p.name) === name);
        if (property === undefined) {
            return undefined;
        }
        if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
            throw unreadable('`' + name + '` is not a plain object literal');
        }
        return property.initializer;
    };

    const calls = findAll(sourceFile, (n): n is ts.CallExpression =>
        ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'defineConfig');
    const config = calls[0]?.arguments[0];
    if (calls.length !== 1 || config === undefined || !ts.isObjectLiteralExpression(config)) {
        throw unreadable('expected exactly one defineConfig({ ... }) call');
    }
    let object: ts.ObjectLiteralExpression | undefined = config;
    for (const name of objectPath) {
        object = object === undefined ? undefined : objectAt(object, name);
    }
    return { sourceFile, properties: object?.properties ?? [], unreadable };
}

/** `key -> dir` for each `key: resolve(..., 'dir')` under `objectPath` of the config's defineConfig call. */
export function readAliases(configFile: string, objectPath: readonly string[]): Map<string, string> {
    const { sourceFile, properties, unreadable } = aliasBlock(configFile, objectPath, 'readAliases');
    const aliases = new Map<string, string>();
    for (const property of properties) {
        const key = propertyNameText(property.name);
        const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
        const target = value !== undefined && ts.isCallExpression(value)
            ? value.arguments[value.arguments.length - 1]
            : undefined;
        if (key === undefined || target === undefined || !ts.isStringLiteral(target)) {
            throw unreadable('alias `' + property.getText(sourceFile) + '` is not `key: resolve(..., \'dir\')`');
        }
        aliases.set(key, path.posix.normalize(target.text));
    }
    return aliases;
}

/** The source text of each alias call's first argument; every call must be exactly `resolve(anchor, 'dir')`. */
export function aliasAnchors(configFile: string, objectPath: readonly string[]): string[] {
    const { sourceFile, properties, unreadable } = aliasBlock(configFile, objectPath, 'aliasAnchors');
    return properties.map((property) => {
        const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
        const anchor = value !== undefined && ts.isCallExpression(value) && ts.isIdentifier(value.expression) &&
            value.expression.text === 'resolve' && value.arguments.length === 2 ? value.arguments[0] : undefined;
        if (anchor === undefined) {
            throw unreadable('alias `' + property.getText(sourceFile) + '` is not `key: resolve(anchor, \'dir\')`');
        }
        return anchor.getText(sourceFile);
    });
}

/** The repository path a relative or aliased specifier names, or undefined for a package. */
export function resolveSpecifier(fromFile: string, specifier: string, aliases: ReadonlyMap<string, string>): string | undefined {
    if (specifier.startsWith('.')) {
        return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    }
    for (const [alias, target] of aliases) {
        if (specifier === alias || specifier.startsWith(alias + '/')) {
            return path.posix.normalize(target + specifier.slice(alias.length));
        }
    }
    return undefined;
}

export const RESOLVE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '/index.ts', '/index.tsx'];

/** Resolves a relative or aliased specifier to a repository file, or undefined if none exists. */
export function resolveModuleFile(fromFile: string, specifier: string, aliases: ReadonlyMap<string, string>): string | undefined {
    const base = resolveSpecifier(fromFile, specifier, aliases);
    if (base === undefined) {
        return undefined;
    }
    for (const candidate of [base, ...RESOLVE_EXTENSIONS.map((ext) => base + ext)]) {
        const abs = path.join(repoRoot, candidate);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            return candidate;
        }
    }
    return undefined;
}
